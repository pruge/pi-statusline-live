// slim/max 표시 칩 — 표시 전용이다. 정책(pi-ctx)을 읽지 않고, 세션 모델의
// 현재 창과 네이티브(카탈로그) 창을 비교해 "창이 열려 있는가"만 말한다.
// - 현재 창 < 네이티브 창 → 🔒slim (pi-ctx 가 캡을 적용해 창을 줄여 둔 상태)
// - 현재 창 == 네이티브 창 → 🔓max (전체 창)
// - 판정 불가(창 0, 카탈로그 0, 네이티브가 더 작음=오버라이드 축소) → 침묵
export type CapChip = "slim" | "max" | null;

export function capChip(currentWindow: number, nativeWindow: number): CapChip {
	if (!(currentWindow > 0) || !(nativeWindow > 0)) return null;
	if (currentWindow === nativeWindow) return "max";
	// slim 은 min(cap, full) 이므로 현재 창은 네이티브보다 클 수 없다.
	// 네이티브가 더 작게 보이면 카탈로그를 못 믿는 자리다 — 칩 대신 침묵이 정직하다.
	if (currentWindow > nativeWindow) return null;
	return "slim";
}
