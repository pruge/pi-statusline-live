/**
 * ctx-cap — 모델 컨텍스트 창 상한(캡)의 순수 규칙 + 설정/세션 계약.
 *
 * 왜 필요한가: pi 는 자동 compact 를 `contextTokens > contextWindow - reserveTokens`
 * 로 판정한다(compaction.ts `shouldCompact`). 즉 "얼마에서 compact 되는가"는
 * **모델의 contextWindow** 하나로 결정된다. reserveTokens 를 키우는 우회로는
 * (1) 전역 설정이라 다른 모델까지 compact 시키고 (2) 요약 maxTokens = 0.8*reserve
 * 라서 요약 출력 상한이 128k 로 폭주한다. 그래서 여기서는 **모델별 창**만 만진다.
 *
 * 0.3.0 — 전 모델 + 세션·모델별 영속:
 *   slim = min(cap, full)  ·  max = full  (full = providers 오버라이드 ?? 카탈로그 창)
 *   어떤 모델이든 카탈로그 창이 cap 이상이면 캡 대상이다. codex 처럼 카탈로그가
 *   과소 보고되는 모델만 `providers` 오버라이드로 실제 창을 따로 적어 둔다.
 *   미기록 모델은 slim(기본). 카탈로그 창이 cap 미만인 소형 모델은 건드리지 않는다.
 *
 * 두 층으로 나뉜다 — 이게 "한 세션·모델만"의 핵심이다:
 *
 *   1) 전역 설정  ~/.pi/agent/ctx-window.json  (모든 세션이 공유하는 기본값)
 *      shape: { v:1, cap, providers: { <providerId>: <fullWindowOverride> } }
 *      → 캡 수치와 카탈로그-불일치 오버라이드만 담는다. 해제 스위치는 여기 없다.
 *   2) 세션 상태  pi.appendEntry("ctx-cap", { states })  (그 세션 파일에만 남는다)
 *      states: { "<provider>/<modelId>": true|max, false|slim }
 *      → resume 해도 그 세션의 모델별 선호만 복원되고, 다른 세션은 캡 그대로다.
 *      구 세션의 { released } 스위치는 states 가 없을 때까지 읽어 준다(하위 호환).
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
	/** @deprecated 구 세션 스위치. `states` 가 없는 entry 에서만 읽는다. */
	released?: boolean;
	/** modelKey(`provider/id`) → true 면 max(해제). 마지막 entry 스냅샷이 이긴다. 미기록 = slim. */
	states?: Record<string, boolean>;
}

/** 세션 entry 에 쓰는 모델 키. `provider/id` — 둘 다 모르면 `?/?`. */
export function modelKeyOf(provider: string | undefined, id: string | undefined): string {
	return `${provider ?? "?"}/${id ?? "?"}`;
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

interface CapEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

function isCapEntry(e: CapEntryLike): e is CapEntryLike & { data: CtxCapEntry } {
	return e?.type === "custom" && e.customType === CTX_CAP_ENTRY && !!e.data && typeof e.data === "object";
}

/**
 * 세션 entries 를 "마지막 ctx-cap 스냅샷"으로 읽는다.
 * states 가 있으면 그 스냅샷만 쓰고 구 released 는 무시한다(하위 호환: states 없는 구 세션은 legacy 만).
 */
export function loadCapSnapshot(
	entries: ReadonlyArray<CapEntryLike> | undefined,
): { states: Record<string, boolean>; legacy: boolean } {
	let states: Record<string, boolean> = {};
	let legacy = false;
	let sawStates = false;
	for (const e of entries ?? []) {
		if (!isCapEntry(e)) continue;
		const d = e.data;
		if (d.states && typeof d.states === "object") {
			sawStates = true;
			legacy = false; // 스냅샷이 구 session-wide 스위치를 대체한다
			states = {};
			for (const [k, v] of Object.entries(d.states)) if (typeof v === "boolean") states[k] = v;
		} else if (!sawStates && typeof d.released === "boolean") {
			legacy = d.released;
		}
	}
	return { states, legacy };
}

/**
 * modelKey 의 max 여부. states 스냅샷에 있으면 그 값, 없으면 legacy(구 세션 스위치),
 * 그것도 없으면 false(slim = 기본).
 */
export function stateFor(
	entries: ReadonlyArray<CapEntryLike> | undefined,
	modelKey: string,
): boolean {
	const { states, legacy } = loadCapSnapshot(entries);
	if (Object.prototype.hasOwnProperty.call(states, modelKey)) return states[modelKey] === true;
	return legacy;
}

/**
 * 이 모델이 실제로 가질 contextWindow (전 모델 대상).
 *
 * - full = providers 오버라이드(codex 같은 카탈로그 과소 보고 전용) ?? 카탈로그 창.
 * - 카탈로그 창이 cap 미만인 소형 모델(예: spark 128k, haiku 200k)은 건드리지 않는다.
 * - slim(기본) → min(cap, full) · max(released) → full.
 * - `native <= 0` 이면 그대로(창을 모르면 건드리지 않는다).
 */
export function resolveWindow(native: number, provider: string | undefined, cfg: CtxCapConfig, released: boolean): number {
	if (!(native > 0)) return native;
	if (native < cfg.cap) return native; // 소형 모델 — 캡/released 무관
	const override = provider ? cfg.providers[provider] : undefined;
	const full = typeof override === "number" && override > 0 ? override : native;
	return released ? full : Math.min(cfg.cap, full);
}

/** 사람이 읽는 한 줄. 설정 + 세션 상태만으로 그린다(모델 키는 부르는 쪽이 붙인다). */
export function describeConfig(cfg: CtxCapConfig, released: boolean): string {
	const provs = Object.entries(cfg.providers).map(([k, v]) => `${k}→${fmt(v)}`).join(" ");
	return `${released ? "max(이 세션·이 모델)" : `slim ${fmt(cfg.cap)}(이 세션·이 모델)`} · 전체 모델 · 오버라이드 ${provs || "(없음)"}`;
}

/**
 * 푸터 ctx 앞에 붙는 모드 칩 텍스트. 색은 부르는 쪽이 입힌다.
 * 숫자는 바로 옆 창 분모(272k · 1.1M)가 말하니, 칩은 모드 이름만 말한다.
 */
export function capChipLabel(released: boolean): string {
	return released ? "🔓max" : "🔒slim";
}

export function fmt(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}
