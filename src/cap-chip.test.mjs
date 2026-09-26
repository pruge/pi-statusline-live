// 칩 판정 회귀 — 라벨 문자열이 아니라 상태("slim"/"max"/null)를 고정한다.
import assert from "node:assert/strict";
const { capChip } = await import("./cap-chip.ts");

// codex gpt-5.x: 카탈로그 272k, pi-ctx max 는 오버라이드 1.05M → max 칩
assert.equal(capChip(1_050_000, 272_000), null, "현재 창이 카탈로그보다 크면 판정 불가 — 침묵");
// 1M 모델 + slim 캡(272k) → slim
assert.equal(capChip(272_000, 1_000_000), "slim");
// 캡이 창 이하(haiku 200k, spark 128k) → slim ≡ max, max 칩
assert.equal(capChip(200_000, 200_000), "max");
assert.equal(capChip(128_000, 128_000), "max");
// 창 정보가 없으면 침묵
assert.equal(capChip(0, 1_000_000), null);
assert.equal(capChip(272_000, 0), null);
assert.equal(capChip(undefined, undefined), null);
// 칩 라벨은 렌더 쪽 계약: slim=dim, max=warning
assert.equal(capChip(272_000, 1_000_000) === "slim", true);
console.log("cap-chip.test.mjs: all green");
