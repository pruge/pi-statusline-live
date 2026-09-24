// ctx-cap 계약 테스트 — 캡 규칙/설정 파싱/세션·모델별 max/slim 복원. Run: node src/ctx-cap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CAP, DEFAULT_FULL, CTX_CAP_ENTRY, defaultCtxCap, parseCapToken, parseConfig, releasedFromEntries,
	resolveWindow, describeConfig, capChipLabel, fmt, modelKeyOf, stateFor, loadCapSnapshot,
} from "./ctx-cap.ts";

test("parseCapToken — k/m 접미사와 소수", () => {
	assert.equal(parseCapToken("272k"), 272_000);
	assert.equal(parseCapToken("272K"), 272_000);
	assert.equal(parseCapToken("1m"), 1_000_000);
	assert.equal(parseCapToken("1.05m"), 1_050_000);
	assert.equal(parseCapToken("272000"), 272_000);
	assert.equal(parseCapToken(" 1_000_000 "), 1_000_000);
});

test("parseCapToken — 못 읽는 값은 null", () => {
	for (const bad of ["", "  ", "abc", "0", "-5", "1g", "m", "12kk", "99999999"]) {
		assert.equal(parseCapToken(bad), null, `should reject ${JSON.stringify(bad)}`);
	}
});

test("parseConfig — 빈 입력은 기본값(codex 272k 캡 · 오버라이드 1.05M)", () => {
	const c = parseConfig(undefined);
	assert.deepEqual(c, { v: 1, cap: DEFAULT_CAP, providers: { "openai-codex": DEFAULT_FULL } });
	assert.deepEqual(parseConfig({}), c);
	assert.deepEqual(parseConfig("garbage"), c);
});

test("parseConfig — 해제 스위치는 전역 설정에 없다(세션 몫)", () => {
	// 예전 파일에 enabled 가 남아 있어도 무시하고 전역값만 읽는다
	const c = parseConfig({ enabled: false, cap: 300_000 });
	assert.equal(c.cap, 300_000);
	assert.equal(c.enabled, undefined);
});

test("parseConfig — cap 은 숫자/문자열 둘 다, 깨진 값은 기본으로", () => {
	assert.equal(parseConfig({ cap: 300_000 }).cap, 300_000);
	assert.equal(parseConfig({ cap: "300k" }).cap, 300_000);
	assert.equal(parseConfig({ cap: -1 }).cap, DEFAULT_CAP);
	assert.equal(parseConfig({ cap: "nope" }).cap, DEFAULT_CAP);
});

test("parseConfig — codex 오버라이드는 남고 전역 cap 은 읽는다", () => {
	const c = parseConfig({ providers: { openai: 1_050_000 } });
	assert.equal(c.providers.openai, 1_050_000);
	assert.equal(c.providers["openai-codex"], DEFAULT_FULL);
	// 깨진 항목은 버린다
	assert.equal(parseConfig({ providers: { foo: "x" } }).providers.foo, undefined);
});

test("releasedFromEntries — 구 세션 { released } 하위 호환(마지막이 이긴다)", () => {
	const mk = (released) => ({ type: "custom", customType: CTX_CAP_ENTRY, data: { released } });
	assert.equal(releasedFromEntries(undefined), false);
	assert.equal(releasedFromEntries([]), false);
	assert.equal(releasedFromEntries([mk(true)]), true);
	assert.equal(releasedFromEntries([mk(true), mk(false)]), false);
	assert.equal(releasedFromEntries([mk(false), mk(true)]), true);
	const bad = [
		{ type: "custom", customType: CTX_CAP_ENTRY },
		{ type: "custom", customType: CTX_CAP_ENTRY, data: null },
		{ type: "custom", customType: CTX_CAP_ENTRY, data: "yes" },
		{ type: "custom", customType: CTX_CAP_ENTRY, data: { released: "true" } },
	];
	assert.equal(releasedFromEntries(bad), false);
});

test("resolveWindow — 소형 모델(cap 미만)은 어떤 provider 여도 그대로", () => {
	const cfg = defaultCtxCap();
	// codex spark 128k · anthropic haiku 200k — slim/max 모두 native
	assert.equal(resolveWindow(128_000, "openai-codex", cfg, false), 128_000);
	assert.equal(resolveWindow(128_000, "openai-codex", cfg, true), 128_000);
	assert.equal(resolveWindow(200_000, "anthropic", cfg, false), 200_000);
	assert.equal(resolveWindow(200_000, "anthropic", cfg, true), 200_000);
});

test("resolveWindow — 전 모델: providers 목록에 없어도 1M 카탈로그는 slim 272k / max 1M", () => {
	const cfg = defaultCtxCap();
	// anthropic/cline/opencode 등 — override 없음, full = native
	assert.equal(resolveWindow(1_000_000, "anthropic", cfg, false), DEFAULT_CAP);
	assert.equal(resolveWindow(1_000_000, "anthropic", cfg, true), 1_000_000);
	assert.equal(resolveWindow(1_048_576, "opencode", cfg, false), DEFAULT_CAP);
	assert.equal(resolveWindow(1_048_576, "opencode", cfg, true), 1_048_576);
	assert.equal(resolveWindow(1_000_000, "cline-bridge", cfg, false), DEFAULT_CAP);
	assert.equal(resolveWindow(1_000_000, "cline-bridge", cfg, true), 1_000_000);
});

test("resolveWindow — provider 미지정/창 0 은 처리", () => {
	const cfg = defaultCtxCap();
	assert.equal(resolveWindow(1_000_000, undefined, cfg, false), DEFAULT_CAP); // 전역 캡은 적용
	assert.equal(resolveWindow(1_000_000, undefined, cfg, true), 1_000_000);
	assert.equal(resolveWindow(0, "openai-codex", cfg, false), 0);
	assert.equal(resolveWindow(-1, "openai-codex", cfg, true), -1);
});

test("resolveWindow — codex: 카탈로그 272k + override 1.05M", () => {
	const cfg = defaultCtxCap();
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, false), DEFAULT_CAP);
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, true), DEFAULT_FULL);
});

test("resolveWindow — 한 세션만 released 여도 설정 자체는 안 바뀐다", () => {
	const cfg = defaultCtxCap();
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, true), DEFAULT_FULL); // 이 세션
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, false), DEFAULT_CAP); // 옆 세션
	assert.equal(cfg.cap, DEFAULT_CAP);
	assert.equal(cfg.providers["openai-codex"], DEFAULT_FULL);
});

test("resolveWindow — cap 을 낮추면 그 값으로(전 모델 동일)", () => {
	const cfg = parseConfig({ cap: "100k" });
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, false), 100_000);
	assert.equal(resolveWindow(1_000_000, "anthropic", cfg, false), 100_000);
	assert.equal(resolveWindow(1_000_000, "anthropic", cfg, true), 1_000_000);
});

test("resolveWindow — cap 을 크게 하면(1m) 1M 모델은 slim=max 로 합쳐진다", () => {
	const cfg = parseConfig({ cap: "1m" });
	assert.equal(resolveWindow(1_000_000, "anthropic", cfg, false), 1_000_000);
	assert.equal(resolveWindow(1_000_000, "anthropic", cfg, true), 1_000_000);
});

test("modelKeyOf — provider/id 키, 모르면 ?/?", () => {
	assert.equal(modelKeyOf("openai-codex", "gpt-5.5"), "openai-codex/gpt-5.5");
	assert.equal(modelKeyOf(undefined, "x"), "?/x");
	assert.equal(modelKeyOf("p", undefined), "p/?");
	assert.equal(modelKeyOf(undefined, undefined), "?/?");
});

const mkCap = (data) => ({ type: "custom", customType: CTX_CAP_ENTRY, data });

test("stateFor — entry 없으면 slim(기본)", () => {
	assert.equal(stateFor(undefined, "a/b"), false);
	assert.equal(stateFor([], "a/b"), false);
	assert.equal(stateFor([mkCap({})], "a/b"), false);
});

test("stateFor — 구 세션 { released } 호환: states 없으면 session-wide 로 읽는다", () => {
	assert.equal(stateFor([mkCap({ released: true })], "any/model"), true);
	assert.equal(stateFor([mkCap({ released: false })], "any/model"), false);
	assert.equal(stateFor([mkCap({ released: true }), mkCap({ released: false })], "a/b"), false);
});

test("stateFor — states 스냅샷: 모델별로 다르게, 미기록은 slim", () => {
	const e = [mkCap({ states: { "p/a": true, "p/b": false } })];
	assert.equal(stateFor(e, "p/a"), true);
	assert.equal(stateFor(e, "p/b"), false);
	assert.equal(stateFor(e, "p/c"), false); // 미기록 → slim
});

test("stateFor — states 스냅샷이 legacy released 를 덮는다", () => {
	const e = [mkCap({ released: true }), mkCap({ states: { "p/a": false } })];
	assert.equal(stateFor(e, "p/a"), false);
	assert.equal(stateFor(e, "p/other"), false); // 스냅샷 mode: 미기록은 slim
});

test("stateFor — 마지막 스냅샷이 이긴다", () => {
	const e = [mkCap({ states: { "p/a": false } }), mkCap({ states: { "p/a": true } })];
	assert.equal(stateFor(e, "p/a"), true);
});

test("loadCapSnapshot — 깨진 data 는 빈 스냅샷·legacy false", () => {
	assert.deepEqual(loadCapSnapshot(undefined), { states: {}, legacy: false });
	assert.deepEqual(loadCapSnapshot([mkCap(null)]), { states: {}, legacy: false });
	assert.deepEqual(loadCapSnapshot([mkCap("yes")]), { states: {}, legacy: false });
	assert.deepEqual(loadCapSnapshot([mkCap({ released: "true" })]), { states: {}, legacy: false });
});

test("loadCapSnapshot — states 만 있으면 legacy 무시", () => {
	const r = loadCapSnapshot([mkCap({ released: true }), mkCap({ states: { "p/a": true } })]);
	assert.deepEqual(r.states, { "p/a": true });
	assert.equal(r.legacy, false);
});

test("describeConfig / fmt — 세션·모델 상태가 한 줄에 드러난다", () => {
	assert.match(describeConfig(defaultCtxCap(), false), /slim 272k\(이 세션·이 모델\)/);
	assert.match(describeConfig(defaultCtxCap(), true), /max\(이 세션·이 모델\)/);
	assert.match(describeConfig(defaultCtxCap(), false), /전체 모델/);
	assert.match(describeConfig(defaultCtxCap(), false), /오버라이드 openai-codex→1\.05M/);
	assert.equal(fmt(999), "999");
	assert.equal(fmt(1_050_000), "1.05M");
});

test("capChipLabel — 푸터에서 max/slim 를 눈으로 구분하는 칩", () => {
	assert.equal(capChipLabel(false), "🔒slim");
	assert.equal(capChipLabel(true), "🔓max");
});
