// known / unknown 구분 회귀 — "모른다"가 0% 로 낙수되면 게이지가 빈 컨텍스트를
// 주장한다(실측: compaction 직후 세션이 계속 0/200k 로 보였다).
import assert from "node:assert/strict";
const { contextGauge } = await import("./context-gauge.ts");

// pi 의 post-compaction truth: tokens/percent 모두 null, 창은 살아 있다.
assert.deepEqual(contextGauge({ tokens: null, percent: null, contextWindow: 200_000 }, 200_000), {
	known: false,
	contextWindow: 200_000,
});

// 실제 점유량(104k of 200k) → known, 정수 % 로 내림.
assert.deepEqual(contextGauge({ tokens: 104_228, percent: 52.114, contextWindow: 200_000 }, 200_000), {
	known: true,
	tokens: 104_228,
	percent: 52,
	contextWindow: 200_000,
});

// 정말로 빈 컨텍스트는 0 이 맞다 — unknown 과 달라야 한다.
assert.equal(contextGauge({ tokens: 0, percent: 0, contextWindow: 200_000 }, 200_000)?.known, true);
assert.equal(contextGauge({ tokens: 0, percent: 0, contextWindow: 200_000 }, 200_000)?.percent, 0);

// 창은 usage 가 없으면 세션 모델로 폴백, 둘 다 없거나 0이면 그리지 않는다.
assert.deepEqual(contextGauge({ tokens: null }, 128_000), { known: false, contextWindow: 128_000 });
assert.equal(contextGauge({ tokens: 500, contextWindow: 0 }, 0), null);
assert.equal(contextGauge(undefined, 200_000), null);
assert.equal(contextGauge(null, 200_000), null);
