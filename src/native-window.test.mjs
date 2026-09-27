// 네이티브 창 해석 회귀 — 카탈로그만 보면 slim/max 가 뒤집히는 버그를 고정한다.
// 실제 값: models-store.json 의 openai-codex 는 전부 272k, ctx-window.json 은 1.05M.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { capChip } = await import("./cap-chip.ts");
const { nativeWindow, resolveNativeWindow, nativeWindowKey } = await import("./native-window.ts");

const OVERRIDES = { "openai-codex": 1_050_000 };
const CATALOG_272K = 272_000;

// codex: 카탈로그 272k / 오버라이드 1.05M
assert.equal(nativeWindowKey("openai-codex", "gpt-6-luna"), "openai-codex/gpt-6-luna");
assert.equal(nativeWindowKey("openai/codex", "gpt-6-luna"), undefined, "프로바이더에 / 가 있으면 키로 쓸 수 없다");
assert.equal(resolveNativeWindow({ overrides: OVERRIDES, catalog: CATALOG_272K }, "openai-codex/gpt-6-luna"), 1_050_000);

// 순위: 관측이 카탈로그를 이기지만, 오버라이드는 "캡 해제 창"을 정한다
assert.equal(resolveNativeWindow({ observed: { contextWindow: 400_000 }, overrides: OVERRIDES, catalog: CATALOG_272K }, "openai-codex/x"), 1_050_000, "관측 400k 도 캡 위 → 오버라이드");
assert.equal(resolveNativeWindow({ observed: { contextWindow: 192_000 }, overrides: OVERRIDES, catalog: CATALOG_272K }, "openai-codex/x"), 192_000, "관측 192k 는 캡 아래 → 그대로");
assert.equal(resolveNativeWindow({ observed: { contextWindow: 0 }, overrides: OVERRIDES, catalog: CATALOG_272K }, "openai-codex/x"), 1_050_000, "잘못된 관측은 무시하고 카탈로그로");
assert.equal(resolveNativeWindow({ catalog: 1_000_000 }, "other/x"), 1_000_000, "오버라이드 없는 프로바이더는 카탈로그");
assert.equal(resolveNativeWindow({ overrides: { "openai-codex": "junk" }, catalog: CATALOG_272K }, "openai-codex/x"), CATALOG_272K);
assert.equal(resolveNativeWindow({ catalog: 0 }, "x/y"), 0, "아무것도 없으면 0 = 침묵");

// 카탈로그가 이미 캡 이하면 pi-ctx 는 오버라이드를 무시한다 — spark 가 영구 slim 이 되면 안 된다
assert.equal(resolveNativeWindow({ overrides: OVERRIDES, catalog: 128_000 }, "openai-codex/gpt-5.3-codex-spark"), 128_000);
assert.equal(resolveNativeWindow({ overrides: OVERRIDES, catalog: 200_000 }, "other/x"), 200_000);
assert.equal(resolveNativeWindow({ overrides: { p: 500_000 }, catalog: 400_000, cap: 300_000 }, "p/x"), 500_000, "캡을 올리면 오버라이드가 적용된다");

// ── 버그 그 자체: slim 과 max 의 라벨이 뒤집히지 않는다 ──
assert.equal(capChip(272_000, nativeWindow("openai-codex", "gpt-6-luna", CATALOG_272K)), "slim", "/ctx slim → 🔒slim");
assert.equal(capChip(1_050_000, nativeWindow("openai-codex", "gpt-6-luna", CATALOG_272K)), "max", "/ctx max → 🔓max");
assert.equal(capChip(200_000, nativeWindow("other", "haiku", 200_000)), "max", "캡보다 작은 창은 slim ≡ max");
assert.equal(capChip(128_000, nativeWindow("openai-codex", "gpt-5.3-codex-spark", 128_000)), "max", "spark 128k = 네이티브 → max");

// ── 디스크 경로: 실제 ~/.pi 대신 임시 홈으로 ──
const home = mkdtempSync(join(tmpdir(), "pi-statusline-native-"));
mkdirSync(join(home, ".pi", "agent", "pi-ctx"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "ctx-window.json"), JSON.stringify({ v: 1, cap: 272_000, providers: OVERRIDES }));
writeFileSync(join(home, ".pi", "agent", "pi-ctx", "windows.json"), JSON.stringify({ "codebuddy/hy3": { contextWindow: 192_000 } }));
process.env.PI_CTX_WINDOWS_PATH = join(home, ".pi", "agent", "pi-ctx", "windows.json");

assert.equal(nativeWindow("openai-codex", "gpt-6-luna", CATALOG_272K, home), 1_050_000);
assert.equal(nativeWindow("codebuddy", "hy3", 999_000, home), 192_000, "관측이 카탈로그를 이긴다");
assert.equal(nativeWindow("opencode", "sonnet", 200_000, home), 200_000, "관측도 오버라이드도 없으면 카탈로그");
assert.equal(nativeWindow("openai-codex", "gpt-5.3-codex-spark", 128_000, home), 128_000, "캡 이하 카탈로그에는 오버라이드 미적용");

// 깨진 파일은 조용히 카탈로그로, 예외는 밖으로 (mtime 캐시와 겹치지 않게 새 홈)
const broken = mkdtempSync(join(tmpdir(), "pi-statusline-native-broken-"));
mkdirSync(join(broken, ".pi", "agent"), { recursive: true });
writeFileSync(join(broken, ".pi", "agent", "ctx-window.json"), "{ broken");
process.env.PI_CTX_WINDOWS_PATH = join(broken, ".pi", "agent", "pi-ctx", "windows.json");
assert.equal(nativeWindow("openai-codex", "gpt-6-luna", CATALOG_272K, broken), CATALOG_272K);
assert.equal(nativeWindow(undefined, undefined, CATALOG_272K, broken), CATALOG_272K, "모델 미선택 = 키 없음 = 카탈로그");
delete process.env.PI_CTX_WINDOWS_PATH;

console.log("native-window.test.mjs: all green");
