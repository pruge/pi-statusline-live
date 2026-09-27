// 칩 판정 회귀 — 라벨 문자열이 아니라 상태("slim"/"max"/null)를 고정한다.
import assert from "node:assert/strict";
const { capChip } = await import("./cap-chip.ts");

// codex gpt-5.x: 네이티브는 카탈로그(272k)가 아니라 pi-ctx 해석식의 1.05M — native-window.ts 참조.
// 네이티브를 카탈로그로만 재면 아래 케이스가 "판정 불가" 로 굳어 slim 에서 max 로 잘못 나온다.
assert.equal(capChip(272_000, 1_050_000), "slim", "codex slim: 272k 캡 vs 1.05M 네이티브");
assert.equal(capChip(1_050_000, 1_050_000), "max", "codex max: 창 == 네이티브");
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
