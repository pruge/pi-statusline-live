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

// 2026-09-19 실측(GET api.cline.bot/api/v1/users/me/plan/usage-limits, HTTP 200).
// 서버가 사용률(percentUsed)을 직접 계산해서 준다 — 클라이언트가 plan 한도와 usages 거래를
// 합성하면 비구독 사용량까지 끌어오므로(실측: 18% vs 홈페이지 0%) 이 엔드포인트가 정답이다.
const CLINE_LIMITS_LIVE = {
	data: {
		limits: [
			{ type: "five_hour", percentUsed: 0, resetsAt: "2026-09-19T13:17:50.05077311Z" },
			{ type: "weekly", percentUsed: 0, resetsAt: "2026-09-26T08:17:50.052593478Z" },
			{ type: "monthly", percentUsed: 0, resetsAt: "2026-10-19T08:17:50.054702677Z" },
		],
	},
	success: true,
};

test("clineWindows — 실측 percentUsed(사용률)를 남은 퍼센트로 뒤집고 5h/7d/30d 로 라벨한다", () => {
	const out = clineWindows(CLINE_LIMITS_LIVE);
	assert.deepEqual(out, [
		{ label: "5h", remainPct: 100, resetsAt: Date.parse("2026-09-19T13:17:50.05077311Z") },
		{ label: "7d", remainPct: 100, resetsAt: Date.parse("2026-09-26T08:17:50.052593478Z") },
		{ label: "30d", remainPct: 100, resetsAt: Date.parse("2026-10-19T08:17:50.054702677Z") },
	]);
});

test("clineWindows — 사용률을 쓰면 남은 비율로 바꾸고, 범위 밖은 0..100 으로 자른다", () => {
	const out = clineWindows({ data: { limits: [
		{ type: "five_hour", percentUsed: 42, resetsAt: "2026-09-19T13:17:50Z" },
		{ type: "weekly", percentUsed: 137, resetsAt: "2026-09-26T08:17:50Z" },
	] } });
	assert.deepEqual(out, [
		{ label: "5h", remainPct: 58, resetsAt: Date.parse("2026-09-19T13:17:50Z") },
		{ label: "7d", remainPct: 0, resetsAt: Date.parse("2026-09-26T08:17:50Z") },
	]);
});

test("clineWindows — limits 가 없거나 비정상이면 빈 배열(게이지 없음)", () => {
	assert.deepEqual(clineWindows({ data: { limits: [] } }), []);
	assert.deepEqual(clineWindows({ data: {} }), []);
	assert.deepEqual(clineWindows({}), []);
});

test("clineWindows — 모르는 type 이나 비정수 percentUsed 면 그 창만 건너뛴다", () => {
	const out = clineWindows({ data: { limits: [
		{ type: "five_hour", percentUsed: 10, resetsAt: "2026-09-19T13:17:50Z" },
		{ type: "quarterly", percentUsed: 5, resetsAt: "2026-12-19T08:00:00Z" }, // 모르는 type
		{ type: "weekly", percentUsed: "n/a", resetsAt: "2026-09-26T08:17:50Z" }, // 비정수
	] } });
	assert.deepEqual(out.map((w) => w.label), ["5h"]);
});


test("toMs — 초는 ms 로, ms 는 그대로, 문자열 ISO 도 받는다", () => {
	assert.equal(toMs(1789615956), 1789615956000);
	assert.equal(toMs(1789615956000), 1789615956000);
	assert.equal(toMs("2026-09-17T00:00:00Z"), Date.parse("2026-09-17T00:00:00Z"));
	assert.equal(toMs(null), 0);
});
