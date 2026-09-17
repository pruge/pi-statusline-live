// quota-windows 계약 테스트 — 실측 payload 모양 고정. Run: node src/quota-windows.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { codexWindows, opencodeWindows, toMs } from "./quota-windows.ts";

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

test("toMs — 초는 ms 로, ms 는 그대로, 문자열 ISO 도 받는다", () => {
	assert.equal(toMs(1789615956), 1789615956000);
	assert.equal(toMs(1789615956000), 1789615956000);
	assert.equal(toMs("2026-09-17T00:00:00Z"), Date.parse("2026-09-17T00:00:00Z"));
	assert.equal(toMs(null), 0);
});
