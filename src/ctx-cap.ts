/**
 * ctx-cap — 모델 컨텍스트 창 상한(캡)의 순수 규칙 + 설정/세션 계약.
 *
 * 왜 필요한가: pi 는 자동 compact 를 `contextTokens > contextWindow - reserveTokens`
 * 로 판정한다(compaction.ts `shouldCompact`). 즉 "얼마에서 compact 되는가"는
 * **모델의 contextWindow** 하나로 결정된다. reserveTokens 를 키우는 우회로는
 * (1) 전역 설정이라 다른 모델까지 compact 시키고 (2) 요약 maxTokens = 0.8*reserve
 * 라서 요약 출력 상한이 128k 로 폭주한다. 그래서 여기서는 **모델별 창**만 만진다.
 *
 * OpenAI(Codex 포함)의 gpt-5.x 는 카탈로그에 short-context 가격 tier 인 272000 이
 * 박혀 있지만 실제 창은 1050000 이다. 기본(off)은 그 tier(272k)로 묶어 두되(현행과
 * 동일한 지점에서 자동 compact), `/ctx on` 을 친 **그 세션만** 실제 창까지 연다.
 *
 * 두 층으로 나뉜다 — 이게 "한 세션만"의 핵심이다:
 *
 *   1) 전역 설정  ~/.pi/agent/ctx-window.json  (모든 세션이 공유하는 기본값)
 *      shape: { v:1, cap, providers: { <providerId>: <fullWindow> } }
 *      → 캡 수치와 "실제 창"만 담는다. 해제 스위치는 여기 없다.
 *   2) 세션 상태  pi.appendEntry("ctx-cap", { released })  (그 세션 파일에만 남는다)
 *      → resume 해도 그 세션만 해제 상태가 복원되고, 다른 세션은 캡 그대로다.
 *
 * 이 모듈은 파일·pi 런타임을 모른다 — 규칙과 파싱만. IO 는 extensions/ 쪽.
 */

export const DEFAULT_CAP = 272_000; // OpenAI short-context tier 경계 = 현행 codex 창
export const DEFAULT_FULL = 1_050_000; // 실제 long-context 창
export const CTX_CAP_FILE = "ctx-window.json"; // ~/.pi/agent/ 아래 (전역 기본값)
export const CTX_CAP_ENTRY = "ctx-cap"; // 세션 custom entry 의 customType
const MAX_SANE = 10_000_000;

export interface CtxCapConfig {
	v: 1;
	/** 캡 토큰 수(전역 기본값) */
	cap: number;
	/** provider id → 그 provider 모델의 실제(풀) 창 */
	providers: Record<string, number>;
}

/** 세션 custom entry 에 저장하는 모양. */
export interface CtxCapEntry {
	released: boolean;
}

export function defaultCtxCap(): CtxCapConfig {
	return { v: 1, cap: DEFAULT_CAP, providers: { "openai-codex": DEFAULT_FULL } };
}

/**
 * "272k" · "1m" · "1.05m" · "272000" → 토큰 수. 못 읽거나 비상식이면 null.
 * k/K = 1e3, m/M = 1e6. 소수 허용(1.05m).
 */
export function parseCapToken(raw: string): number | null {
	const s = String(raw ?? "").trim().toLowerCase().replace(/[_,]/g, "");
	if (!s) return null;
	const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const mult = m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1;
	const tokens = Math.round(n * mult);
	return tokens > 0 && tokens <= MAX_SANE ? tokens : null;
}

function saneNumber(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? parseCapToken(v) : null;
	return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= MAX_SANE ? Math.round(n) : null;
}

/** 저장된 JSON(깨졌을 수 있다) → 항상 유효한 설정. 빠진 필드는 기본값. */
export function parseConfig(raw: unknown): CtxCapConfig {
	const def = defaultCtxCap();
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const cap = saneNumber(o.cap) ?? def.cap;
	const providers: Record<string, number> = { ...def.providers };
	const p = o.providers;
	if (p && typeof p === "object") {
		for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
			const n = saneNumber(v);
			if (n !== null) providers[String(k)] = n;
		}
	}
	return { v: 1, cap, providers };
}

/** 세션 entries 의 마지막 "ctx-cap" custom entry 에서 해제 여부를 읽는다(없으면 false). */
export function releasedFromEntries(
	entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }> | undefined,
): boolean {
	let released = false;
	for (const e of entries ?? []) {
		if (e?.type !== "custom" || e.customType !== CTX_CAP_ENTRY) continue;
		const d = e.data as CtxCapEntry | undefined;
		if (d && typeof d === "object") released = d.released === true;
	}
	return released;
}

/**
 * 이 모델이 실제로 가질 contextWindow.
 *
 * - 대상 provider 가 아니면 카탈로그 값 그대로(다른 provider 무영향).
 * - 카탈로그 창이 캡보다 작은 진짜 소형 모델(예: gpt-5.3-codex-spark 128k)은 건드리지 않는다.
 * - 대상이면: 캡 → min(cap, full) · released → full.
 */
export function resolveWindow(native: number, provider: string | undefined, cfg: CtxCapConfig, released: boolean): number {
	if (!(native > 0)) return native;
	const full = provider ? cfg.providers[provider] : undefined;
	if (!(typeof full === "number" && full > 0)) return native;
	if (native < cfg.cap) return native;
	return released ? full : Math.min(cfg.cap, full);
}

/** 사람이 읽는 한 줄. 모델 없이 설정 + 세션 상태만으로 그린다. */
export function describeConfig(cfg: CtxCapConfig, released: boolean): string {
	const provs = Object.entries(cfg.providers).map(([k, v]) => `${k}→${fmt(v)}`).join(" ");
	return `${released ? "1M ON(이 세션)" : `${fmt(cfg.cap)} 캡(이 세션)`} · 대상 ${provs || "(없음)"}`;
}

/**
 * 푸터 ctx 앞에 붙는 칩 텍스트. 색은 부르는 쪽이 입힌다.
 * 해제는 모드 이름(1.05M → "1M"), 캡은 캡 값(272k).
 */
export function capChipLabel(released: boolean, cap: number, full: number): string {
	if (!released) return `🔒${fmt(cap)}`;
	return full >= 1_000_000 && full < 2_000_000 ? "🔓1M" : `🔓${fmt(full)}`;
}

export function fmt(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}
