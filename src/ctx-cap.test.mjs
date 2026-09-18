// ctx-cap 계약 테스트 — 캡 규칙/설정 파싱/세션 해제 복원. Run: node src/ctx-cap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CAP, DEFAULT_FULL, CTX_CAP_ENTRY, defaultCtxCap, parseCapToken, parseConfig, releasedFromEntries,
	resolveWindow, describeConfig, capChipLabel, fmt,
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

test("parseConfig — 빈 입력은 기본값(codex 272k 캡 · 실제 창 1.05M)", () => {
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

test("parseConfig — providers 머지: 준 것만 덮고 기본 codex 는 유지", () => {
	const c = parseConfig({ providers: { openai: 1_050_000 } });
	assert.equal(c.providers.openai, 1_050_000);
	assert.equal(c.providers["openai-codex"], DEFAULT_FULL);
	// 깨진 항목은 버린다
	assert.equal(parseConfig({ providers: { foo: "x" } }).providers.foo, undefined);
});

test("releasedFromEntries — entry 없으면 캡(기본)", () => {
	assert.equal(releasedFromEntries(undefined), false);
	assert.equal(releasedFromEntries([]), false);
	assert.equal(releasedFromEntries([{ type: "message" }, { type: "custom", customType: "other", data: { released: true } }]), false);
});

test("releasedFromEntries — 마지막 ctx-cap entry 가 이긴다", () => {
	const mk = (released) => ({ type: "custom", customType: CTX_CAP_ENTRY, data: { released } });
	assert.equal(releasedFromEntries([mk(true)]), true);
	assert.equal(releasedFromEntries([mk(true), mk(false)]), false);
	assert.equal(releasedFromEntries([mk(false), mk(true)]), true);
	assert.equal(releasedFromEntries([mk(false), { type: "message" }, mk(true)]), true);
});

test("releasedFromEntries — 깨진 data 는 캡으로(해제로 승격하지 않는다)", () => {
	const bad = [
		{ type: "custom", customType: CTX_CAP_ENTRY },
		{ type: "custom", customType: CTX_CAP_ENTRY, data: null },
		{ type: "custom", customType: CTX_CAP_ENTRY, data: "yes" },
		{ type: "custom", customType: CTX_CAP_ENTRY, data: { released: "true" } },
	];
	assert.equal(releasedFromEntries(bad), false);
});

test("resolveWindow — 대상 아닌 provider 는 건드리지 않는다", () => {
	const cfg = defaultCtxCap();
	assert.equal(resolveWindow(200_000, "anthropic", cfg, false), 200_000);
	assert.equal(resolveWindow(1_000_000, "github-copilot", cfg, true), 1_000_000);
});

test("resolveWindow — 캡: 272k 로 묶는다(현행과 동일 지점 compact)", () => {
	assert.equal(resolveWindow(272_000, "openai-codex", defaultCtxCap(), false), 272_000);
});

test("resolveWindow — released: 실제 창까지 연다", () => {
	assert.equal(resolveWindow(272_000, "openai-codex", defaultCtxCap(), true), DEFAULT_FULL);
});

test("resolveWindow — 한 세션만 released 여도 설정 자체는 안 바뀐다", () => {
	const cfg = defaultCtxCap();
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, true), DEFAULT_FULL); // 이 세션
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, false), DEFAULT_CAP); // 옆 세션
});

test("resolveWindow — 진짜 소형 모델(spark 128k)은 캡/released 무관", () => {
	const cfg = defaultCtxCap();
	assert.equal(resolveWindow(128_000, "openai-codex", cfg, false), 128_000);
	assert.equal(resolveWindow(128_000, "openai-codex", cfg, true), 128_000);
});

test("resolveWindow — cap 을 낮추면 그 값으로", () => {
	const cfg = parseConfig({ cap: "100k" });
	assert.equal(resolveWindow(272_000, "openai-codex", cfg, false), 100_000);
});

test("resolveWindow — 창을 모르면(null/0) 그대로", () => {
	const cfg = defaultCtxCap();
	assert.equal(resolveWindow(0, "openai-codex", cfg, false), 0);
	assert.equal(resolveWindow(-1, "openai-codex", cfg, true), -1);
});

test("describeConfig / fmt — 세션 상태가 한 줄에 드러난다", () => {
	assert.match(describeConfig(defaultCtxCap(), false), /272k 캡\(이 세션\)/);
	assert.match(describeConfig(defaultCtxCap(), true), /1M ON\(이 세션\)/);
	assert.match(describeConfig(defaultCtxCap(), false), /openai-codex→1\.05M/);
	assert.equal(fmt(999), "999");
	assert.equal(fmt(1_050_000), "1.05M");
});

test("capChipLabel — 푸터에서 1M/272k 를 눈으로 구분하는 칩", () => {
	// 캡(기본): 잠금 + 캡 값
	assert.equal(capChipLabel(false, 272_000, 1_050_000), "🔒272k");
	assert.equal(capChipLabel(false, 300_000, 1_050_000), "🔒300k");
	// 해제: 열림 + 모드 이름(1.0~1.9M 은 1M)
	assert.equal(capChipLabel(true, 272_000, 1_050_000), "🔓1M");
	assert.equal(capChipLabel(true, 272_000, 1_000_000), "🔓1M");
	// 1M 대역이 아니면 실제 값
	assert.equal(capChipLabel(true, 272_000, 800_000), "🔓800k");
	assert.equal(capChipLabel(true, 272_000, 2_000_000), "🔓2M");
});
