// 컨텍스트 게이지 판정 — 표시 전용이다. pi 의 getContextUsage() 가 말하는
// "아직 안다 / 모른다"를 렌더 상태로 바꾼다.
// - known: 마지막 어시스턴트 usage 로 얻은 점유량 → NN% + 채워진 바
// - unknown: 최신 compaction 이후 아직 LLM 응답이 없어 pi 가 percent=null 로
//   돌려보내는 자리. 0 과 구분해야 정직하다 — 0% 로 그리면 컨텍스트가 비어
//   있다는 거짓말이 된다(pi 내장 푸터는 ?/200k 로 그린다).
// - null: 창 자체가 없다 → 아무것도 그리지 않는다.
export type ContextGauge =
	| { known: true; tokens: number; percent: number; contextWindow: number }
	| { known: false; contextWindow: number }
	| null;

export function contextGauge(
	usage: { tokens?: number | null; contextWindow?: number | null } | undefined | null,
	modelWindow: number
): ContextGauge {
	if (!usage) return null;
	const win = usage.contextWindow ?? modelWindow ?? 0;
	if (!(win > 0)) return null;
	const tokens = usage.tokens;
	if (tokens === null || tokens === undefined) return { known: false, contextWindow: win };
	return { known: true, tokens, percent: Math.floor((tokens * 100) / win), contextWindow: win };
}
