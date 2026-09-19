// quota-windows 계약 테스트 — 실측 payload 모양 고정. Run: node src/quota-windows.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { clineWindows, codexWindows, opencodeWindows, toMs } from "./quota-windows.ts";

// 2026-09-17 실측(GET chatgpt.com/backend-api/wham/usage, HTTP 200). id/email 만 가림.
const CODEX_LIVE = {
	account_id: "acct-fixture",
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_after_seconds: 17890, reset_at: 1789615956 },
		secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 604690, reset_at: 1790202756 },
	},
};

test("codexWindows — 실측 used_percent 를 남은 퍼센트로 뒤집고 5h/7d 로 라벨한다", () => {
	assert.deepEqual(codexWindows(CODEX_LIVE), [
		{ label: "5h", remainPct: 96, resetsAt: 1789615956000 },
		{ label: "7d", remainPct: 99, resetsAt: 1790202756000 },
	]);
});

test("codexWindows — 이미 남은 퍼센트로 보내는 변형도 같은 값으로 읽는다", () => {
	const legacy = { rate_limits: { primary: { remaining_percent: 42, reset_at: 1789615956 }, secondary: { percent_left: 7, reset_at: 1790202756 } } };
	assert.deepEqual(codexWindows(legacy).map((w) => w.remainPct), [42, 7]);
});

test("codexWindows — 창이 없거나 퍼센트가 없으면 빈 배열(게이지 없음)", () => {
	assert.deepEqual(codexWindows({}), []);
	assert.deepEqual(codexWindows({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } }), []);
});

test("codexWindows — 범위를 벗어난 퍼센트는 0..100 으로 자른다", () => {
	const out = codexWindows({ rate_limit: { primary_window: { used_percent: 140 }, secondary_window: { used_percent: -3 } } });
	assert.deepEqual(out.map((w) => w.remainPct), [0, 100]);
});

// 2026-09-17 실측(GET opencode.ai/zen/go/v1/usage, HTTP 200). 키는 응답에 안 들어온다.
const OPENCODE_LIVE = {
	usage: {
		rolling: { status: "ok", percent: 6, resetsAt: "2026-09-17T08:33:43.587Z" },
		weekly: { status: "ok", percent: 33, resetsAt: "2026-09-21T00:00:00.587Z" },
		monthly: { status: "ok", percent: 16, resetsAt: "2026-10-14T21:50:46.587Z" },
	},
};

test("opencodeWindows — 실측 percent(사용률)를 뒤집고 5h/7d/30d 로 라벨한다(monthly 포함)", () => {
	assert.deepEqual(opencodeWindows(OPENCODE_LIVE), [
		{ label: "5h", remainPct: 94, resetsAt: Date.parse("2026-09-17T08:33:43.587Z") },
		{ label: "7d", remainPct: 67, resetsAt: Date.parse("2026-09-21T00:00:00.587Z") },
		{ label: "30d", remainPct: 84, resetsAt: Date.parse("2026-10-14T21:50:46.587Z") },
	]);
});

test("opencodeWindows — monthly 가 없으면 5h/7d 만(게이지 하나가 빠져도 나머지는 산다)", () => {
	const noMonth = { usage: { rolling: { percent: 10, resetsAt: 1789615956 }, weekly: { percent: 20, resetsAt: 1790202756 } } };
	assert.deepEqual(opencodeWindows(noMonth).map((w) => w.label), ["5h", "7d"]);
});

test("opencodeWindows — percent 가 숫자가 아니면 그 창만 건너뛰고, 범위 밖은 0..100 으로 자른다", () => {
	const partial = { usage: { rolling: { status: "exceeded", percent: 102, resetsAt: 1789615956 }, weekly: { status: "ok" }, monthly: { status: "ok", percent: 0, resetsAt: 1790202756 } } };
	assert.deepEqual(opencodeWindows(partial), [
		{ label: "5h", remainPct: 0, resetsAt: 1789615956000 },
		{ label: "30d", remainPct: 100, resetsAt: 1790202756000 },
	]);
});

// 2026-09-19 실측(GET api.cline.bot/api/v1/users/me/plan, HTTP 200). 이메일/id 는 가림.
// 핵심은 data.plan.entitlements.cline_pass.inferenceCapThreshold 의 세 한도.
const CLINE_PLAN_LIVE = {
	planHistoryId: "iph-fixture",
	userId: "usr-fixture",
	plan: {
		id: "pln-fixture",
		displayName: "Cline Pass (Monthly)",
		entitlements: {
			cline_pass: {
				enabled: true,
				inferenceCapThreshold: {
					last5HoursUsageCostUSDPerUser: 1000000000,
					last7daysUsageCostUSDPerUser: 2500000000,
					last30daysUsageCostUSDPerUser: 5000000000,
				},
			},
		},
	},
	subscriptionId: "sub-fixture",
};

// 같은 날 실측한 usages items 의 모양(필드 이름·단위 고정). createdAt 은 창 계산을 위해 손봄.
// 비용은 실측 규모(한 번의 completion ≈ 3~5천 costUsd, 활성 세션의 5h 합은 ~1.5e8) 에 맞췄다.
const CLINE_NOW = Date.parse("2026-09-19T07:38:54Z");
const tx = (minAgo, costUsd) => ({ id: "usg-fixture", createdAt: new Date(CLINE_NOW - minAgo * 60000).toISOString(), costUsd, creditsUsed: 47, operation: "chat_completion" });
const CLINE_USAGES_LIVE = [
	tx(1, 40_000_000),          // 1분 전   ┐
	tx(120, 60_000_000),        // 2시간 전 ┘ 5h 창: 1e8
	tx(6 * 60, 250_000_000),    // 6시간 전   (5h 밖, 7d 안)
	tx(3 * 24 * 60, 300_000_000),  // 3일 전   (7d 안)
	tx(10 * 24 * 60, 700_000_000), // 10일 전  (30d 안)
];

test("clineWindows — 한도로 나눈 사용률을 5h/7d/30d 로 뒤집어 남은 퍼센트로", () => {
	// 5h 창: 1e8 / 1e9 = 10% 사용 → 남 90%
	// 7d 창: 1e8+2.5e8+3e8 = 6.5e8 / 2.5e9 = 26% → 남 74%
	// 30d 창: 6.5e8+7e8 = 1.35e9 / 5e9 = 27% → 남 73%
	const out = clineWindows(CLINE_PLAN_LIVE, CLINE_USAGES_LIVE, CLINE_NOW);
	assert.deepEqual(out.map((w) => w.label), ["5h", "7d", "30d"]);
	assert.deepEqual(out.map((w) => Math.round(w.remainPct * 100) / 100), [90, 74, 73]);
	// rolling 창이라 서버가 주는 리셋이 없다 — 꼬리는 그리지 않는다.
	assert.deepEqual(out.map((w) => w.resetsAt), [0, 0, 0]);
});

test("clineWindows — 구독(한도)이 없으면 빈 배열(게이지 없음, 에러 아님)", () => {
	assert.deepEqual(clineWindows({ plan: { entitlements: { cline_pass: { enabled: false } } } }, CLINE_USAGES_LIVE, CLINE_NOW), []);
	assert.deepEqual(clineWindows({}, CLINE_USAGES_LIVE, CLINE_NOW), []);
});

test("clineWindows — 거래가 없어도 한도가 있으면 100% 남은 게이지 3개", () => {
	assert.deepEqual(clineWindows(CLINE_PLAN_LIVE, [], CLINE_NOW).map((w) => w.remainPct), [100, 100, 100]);
});

test("clineWindows — 한도가 0 이거나 비정수면 그 창만 건너뛴다", () => {
	const caps = { ...CLINE_PLAN_LIVE, plan: { ...CLINE_PLAN_LIVE.plan, entitlements: { cline_pass: { enabled: true, inferenceCapThreshold: { last5HoursUsageCostUSDPerUser: 0, last7daysUsageCostUSDPerUser: 2500000000, last30daysUsageCostUSDPerUser: "x" } } } } };
	assert.deepEqual(clineWindows(caps, CLINE_USAGES_LIVE, CLINE_NOW).map((w) => w.label), ["7d"]);
});

test("clineWindows — 범위 밖 사용량은 0..100 으로 자른다", () => {
	// 2e9 costUsd: 5h 한도(1e9) 초과 → 200% 사용 → 남 0(컷); 7d 은 80% 사용 → 남 20; 30d 은 40% → 남 60.
	assert.deepEqual(clineWindows(CLINE_PLAN_LIVE, [tx(1, 2e9)], CLINE_NOW).map((w) => Math.round(w.remainPct)), [0, 20, 60]);
});

test("toMs — 초는 ms 로, ms 는 그대로, 문자열 ISO 도 받는다", () => {
	assert.equal(toMs(1789615956), 1789615956000);
	assert.equal(toMs(1789615956000), 1789615956000);
	assert.equal(toMs("2026-09-17T00:00:00Z"), Date.parse("2026-09-17T00:00:00Z"));
	assert.equal(toMs(null), 0);
});
