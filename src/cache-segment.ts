/**
 * 캐시 히트율 한 조각 — statusline 의 `↑ ↓ R W` 옆에 붙인다.
 *
 * 순수 함수로 따로 둔다: 이 값은 "내 앞부분이 재사용되고 있는가"를 매 턴 봐야 하는 지표인데,
 * 확장 파일 전체를 import 하지 않고 검사할 수 있어야 한다(회귀를 위해).
 *
 *  히트율 = cacheRead / (cacheRead + cacheWrite + input)
 *   · input 은 맨돈(캐시 밖) 입력, cacheWrite 는 이번 턴에 새로 쓴 것 — 둘 다 벌금이다(1.25×/2×).
 *   · claude-agent-sdk·anthropic 은 첫 메시지까지 경계에 포함 → 워커 브리핑을 헤드/테일로 가르는 이유.
 *   · provider 에 따라 auto cache 는 write 를 0으로 보고하기도 한다(bai 실측) → 분모가 이상하면 null.
 */
export interface CacheStats {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}
export type Tone = "good" | "warn" | "bad" | "dim";

export function cacheRatio(s: CacheStats): number | null {
	const den = (s.cacheRead ?? 0) + (s.cacheWrite ?? 0) + (s.input ?? 0);
	if (den <= 0) return null;
	return s.cacheRead / den;
}

/** 색은 판정이다: 85% 이상 초록, 60% 이상 노랑, 그 아래는 빨강(= 규칙 위반을 의심하라). */
export function cacheTone(r: number | null): Tone {
	if (r == null) return "dim";
	if (r >= 0.85) return "good";
	if (r >= 0.6) return "warn";
	return "bad";
}

/** 라벨: "cache 89%" · 쓰기 우세면 "(W↑)" 를 붙인다(write 가 read 보다 크면 색만으론 이유를 모른다). */
export function cacheLabel(s: CacheStats): string | null {
	const r = cacheRatio(s);
	if (r == null || s.cacheRead + s.cacheWrite === 0) return null;
	return `cache ${Math.round(r * 100)}%` + (s.cacheWrite > s.cacheRead ? "(W↑)" : "");
}

/**
 * 좁은 판에서는 별도 조각이 잘린다(트럭에이션은 뒤부터 먹는다). 그래서 비율을 R 토큰에
 * 접미어로 붙인다: "·89%" / "·28%!!(W↑)".
 * ⚠ 판정을 **색에만 싣지 않는다** — truecolor 가 삼켜지면(herdr/TERM) 전부 일반 텍스트로 보인다.
 *   warn = ! , bad = !! , write 우세 = (W↑)  → 색이 없어도 같은 문장이 읽힌다.
 */
export function cacheReadSuffix(s: CacheStats, tone?: Tone): string {
	const r = cacheRatio(s);
	if (r == null || s.cacheRead + s.cacheWrite === 0) return "";
	const t = tone ?? cacheTone(r);
	const mark = t === "bad" ? "!!" : t === "warn" ? "!" : "";
	return `·${Math.round(r * 100)}%${mark}` + (s.cacheWrite > s.cacheRead ? "(W↑)" : "");
}

/**
 * 테마가 그 이름에 실제로 색을 주는지 **물어보고** 고른다.
 * `t.fg("success", x)` 가 이스케이프를 하나도 붙이지 않으면 그 테마에는 success 항이 없는 것이다 —
 * 그때는 조용히 무색로 뜨므로(실측: 히트율이 초록이 아니라 회색), 색을 내는 항목으로 갈아탄다.
 */
export type ThemeLike = { fg: (name: string, s: string) => string };

export function pickColor(t: ThemeLike, want: string[], probe = "\u0000x"): string | null {
	for (const name of want) {
		let out = "";
		try {
			out = t.fg(name, probe) ?? "";
		} catch {
			continue;
		}
		if (out.includes("\u001b") || out.includes("\x1b")) return name;
	}
	return null;
}

/** 판정(tone) → 테마에서 실제로 색을 내는 이름. 없으면 null(부르는 쪽에서 bold 로 격상한다). */
export function colorForTone(t: ThemeLike, tone: Tone): string | null {
	const want = tone === "good" ? ["success", "green", "accent"] : tone === "warn" ? ["warning", "yellow", "accent"] : tone === "bad" ? ["error", "red"] : [];
	return pickColor(t, want);
}
