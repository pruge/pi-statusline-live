// quota-windows 계약 테스트 — 실측 payload 모양 고정. Run: node src/quota-windows.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { apinexBalance, clineWindows, codexWindows, minimaxWindows, opencodeWindows, toMs } from "./quota-windows.ts";

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

// 2026-09-20 실측(`mmx quota show --output json --quiet`, exit 0). 토큰은 응답에 안 들어온다.
// server 가 **남은 퍼센트**를 그대로 보낸다(codex/opencode/cline 와 반대) — 여기서 뒤집지 않는다.
const MINIMAX_LIVE = {
	model_remains: [
		{
			model_name: "general",                       // 텍스트 모델
			current_interval_status: 1,                  // 1=활성
			current_interval_remaining_percent: 97,       // 5h 남은 %
			start_time: 1789898400000,
			end_time: 1789916400000,                     // 5h 리셋 시각(ms)
			current_weekly_status: 1,
			current_weekly_remaining_percent: 99,         // 7d 남은 %
			weekly_start_time: 1789344000000,
			weekly_end_time: 1789948800000,              // 7d 리셋 시각(ms)
		},
		{
			model_name: "video",                         // video 모델은 statusline 대상 아님(텍스트만)
			current_interval_status: 3,                  // 3=이 모델엔 quota 없음(스킵)
			current_interval_remaining_percent: 100,
			current_weekly_status: 3,
			current_weekly_remaining_percent: 100,
		},
	],
	base_resp: { status_code: 0, status_msg: "success" },
};

test("minimaxWindows — general 항목의 활성(1) 5h/7d 만 게이지로 올리고 video(status 3)는 건너뛴다", () => {
	assert.deepEqual(minimaxWindows(MINIMAX_LIVE), [
		{ label: "5h", remainPct: 97, resetsAt: 1789916400000 },
		{ label: "7d", remainPct: 99, resetsAt: 1789948800000 },
	]);
});

test("minimaxWindows — model_remains 가 없거나 비어있거나 배열이 아니면 빈 배열(게이지 없음)", () => {
	assert.deepEqual(minimaxWindows({}), []);
	assert.deepEqual(minimaxWindows({ model_remains: [] }), []);
	assert.deepEqual(minimaxWindows({ model_remains: "not-an-array" }), []);
});

test("minimaxWindows — video 만 있거나 general 항목이 없으면 빈 배열(텍스트 모델만 본다)", () => {
	assert.deepEqual(minimaxWindows({ model_remains: [{ model_name: "video", current_interval_status: 3 }] }), []);
	assert.deepEqual(minimaxWindows({ model_remains: [{ model_name: "speech" }] }), []);
});

test("minimaxWindows — 범위 밖 퍼센트는 0..100 으로 자르고 status 가 1 이 아니면 그 창만 스킵", () => {
	const out = minimaxWindows({ model_remains: [{
		model_name: "general",
		current_interval_status: 3,                  // 5h 비활성(스킵)
		current_interval_remaining_percent: 200,
		current_weekly_status: 1,
		current_weekly_remaining_percent: -5,        // → 0 으로 클램프
		weekly_end_time: 1789948800000,
	}] });
	assert.deepEqual(out, [{ label: "7d", remainPct: 0, resetsAt: 1789948800000 }]);
});


test("toMs — 초는 ms 로, ms 는 그대로, 문자열 ISO 도 받는다", () => {
	assert.equal(toMs(1789615956), 1789615956000);
	assert.equal(toMs(1789615956000), 1789615956000);
	assert.equal(toMs("2026-09-17T00:00:00Z"), Date.parse("2026-09-17T00:00:00Z"));
	assert.equal(toMs(null), 0);
});

// 2026-10-11 실측(GET api.apinex.bond/v1/balance, HTTP 200). 키 id 는 가림.
// 돈이라 창(QuotaWindow)이 아니라 숫자 — spend_limit_usd 는 한도를 걸었을 때만 나온다.
const APINEX_LIVE = {
	object: "balance",
	balance_usd: 0,
	reserved_usd: 0,
	api_key: { id: "key_fixture", spend_limit_usd: null, spent_usd: 0, reserved_usd: 0, remaining_usd: null, limit_reached: false },
};

test("apinexBalance — 실측 balance_usd(지갑) + api_key.spent_usd(키별 사용량)를 읽는다", () => {
	assert.deepEqual(apinexBalance(APINEX_LIVE), {
		spentUsd: 0,
		balanceUsd: 0,
		limitUsd: null,
		limitReached: false,
	});
});

test("apinexBalance — 지출 한도가 있으면 limitUsd 로, 도달하면 limitReached 로 올라온다", () => {
	const out = apinexBalance({
		...APINEX_LIVE,
		balance_usd: 1.25,
		api_key: { ...APINEX_LIVE.api_key, spend_limit_usd: 5, spent_usd: 0.4, limit_reached: true },
	});
	assert.deepEqual(out, { spentUsd: 0.4, balanceUsd: 1.25, limitUsd: 5, limitReached: true });
});

test("apinexBalance — balance_usd 가 숫자가 아니면 null(칩 없음)", () => {
	assert.equal(apinexBalance({}), null);
	assert.equal(apinexBalance({ object: "balance", balance_usd: "n/a" }), null);
	assert.equal(apinexBalance(null), null);
	// spent_usd 가 깨졌어도 지갑은 읽는다 — 사용량 0 으로 본다
	assert.equal(apinexBalance({ balance_usd: 2, api_key: { spent_usd: "n/a" } })?.spentUsd, 0);
});
