// 캐시 조각의 회귀 — 이 값들이 푸터에 뜨는 문자열이다.
// 숫자는 지어낸 게 아니라 실세션에서 가져왔다(cache-report 로 뽑은 것들).
import assert from "node:assert/strict";
const { cacheRatio, cacheTone, cacheLabel, cacheReadSuffix, pickColor, colorForTone, cacheEmphasis, cachePaint, CACHE_LITERAL, GOOD_OPTIONS } = await import("./cache-segment.ts");

// 이 오케스트레이터 세션: ↑32.0M ↓665k R254.9M
assert.equal(cacheReadSuffix({ input: 32_000_000, cacheRead: 254_900_000, cacheWrite: 0 }), " 89%");
assert.equal(cacheTone(cacheRatio({ input: 32_000_000, cacheRead: 254_900_000, cacheWrite: 0 })), "good");
// 브리핑 규약 없던 워크트리 워커: read 97.2k / write 182.4k / in 63k → 28%, 쓰기가 이긴다
assert.equal(cacheReadSuffix({ input: 63_000, cacheRead: 97_200, cacheWrite: 182_400 }), " 28%(W↑)", "강조 기호는 없다 — 색이 판정을 말한다");
assert.equal(cacheReadSuffix({ input: 40_000_000, cacheRead: 40_000_000, cacheWrite: 0 }), " 50%");
assert.equal(cacheReadSuffix({ input: 12_000_000, cacheRead: 40_000_000, cacheWrite: 0 }), " 77%");
assert.equal(cacheLabel({ input: 63_000, cacheRead: 97_200, cacheWrite: 182_400 }), "cache 28%(W↑)");
assert.equal(cacheTone(cacheRatio({ input: 63_000, cacheRead: 97_200, cacheWrite: 182_400 })), "bad");
// 전부 재사용(히스토리가 그대로 캐시된 뒤 같은 문장 재발송)
assert.equal(cacheRatio({ input: 0, cacheRead: 39_610, cacheWrite: 0 }), 1);
// provider 가 usage 를 안 주는 경로 → 침묵 (0% 라고 거짓말하지 않는다)
assert.equal(cacheReadSuffix({ input: 5, cacheRead: 0, cacheWrite: 0 }), "");
assert.equal(cacheLabel({ input: 5, cacheRead: 0, cacheWrite: 0 }), null);
assert.equal(cacheTone(null), "dim");
// 경계값: 85% 는 good, 84% 는 warn
assert.equal(cacheTone(0.85), "good");
assert.equal(cacheTone(0.84), "warn");
assert.equal(cacheTone(0.6), "warn");
assert.equal(cacheTone(0.59), "bad");
// 색: 테마에 success 가 있으면 그 이름, 없으면 다음으로, 아무것도 없으면 null(bold 로 격상)
const colored = { fg: (n, s) => (["success", "warning", "error", "accent", "dim"].includes(n) ? `\u001b[32m${s}\u001b[0m` : s) };
const colorless = { fg: (_n, s) => s };
assert.equal(colorForTone(colored, "good"), "success");
assert.equal(colorForTone(colored, "bad"), "error");
assert.equal(colorForTone(colorless, "good"), null, "테마가 무색이면 null — 부르는 쪽이 bold 로 대체한다");
const partial = { fg: (n, s) => (n === "accent" ? `\u001b[36m${s}\u001b[0m` : s) };
assert.equal(colorForTone(partial, "good"), "accent", "success 가 없으면 같은 판정의 다른 색으로 갈아탄다");
// 턴당 읽기 라벨 — 누적 cacheRead 은 턴 수에 비례해서 커지므로(≈ 컨텍스트 × 턴) 세션 비교가 안 된다.
const { cacheReadLabel, fmtK } = await import("./cache-segment.ts");
assert.equal(fmtK(2_855_600), "2.9M");
assert.equal(fmtK(60_800), "61k");
assert.equal(cacheReadLabel({ cacheRead: 2_855_600, turns: 47 }), "R61k/턴");
assert.equal(cacheReadLabel({ cacheRead: 0, turns: 0 }), "R0/턴", "0으로 나누지 않는다");
assert.equal(cacheReadLabel({ cacheRead: 25_000, turns: 2 }), "R13k/턴");

// ANSI 강등 — truecolor 를 삼키는 터미널에서도 판정이 살아야 한다
const { detectColorMode, downgradeAnsi } = await import("./ansi.ts");
const dark = { success: "\u001b[38;2;181;189;104m", warning: "\u001b[38;2;255;255;0m", error: "\u001b[38;2;204;102;102m", dim: "\u001b[38;2;102;102;102m" };
assert.match(downgradeAnsi(dark.success + "R97.2k·28%!!(W↑)\x1b[39m", "256"), /^\x1b\[38;5;\d{1,3}m/);
assert.equal(downgradeAnsi(dark.success + "ok\x1b[39m", "16"), "\x1b[92mok\x1b[39m", "green 계보 → 밝은 초록");
assert.equal(downgradeAnsi(dark.warning + "ok\x1b[39m", "16"), "\x1b[33mok\x1b[39m", "노랑은 밝기 비트를 더하지 않는다(93 은 따로 존재)");
assert.equal(downgradeAnsi(dark.error + "ok\x1b[39m", "16"), "\x1b[91mok\x1b[39m", "red 계보 → 밝은 빨강(204,102,102)");
assert.equal(downgradeAnsi(dark.dim + "ok\x1b[39m", "16"), "\x1b[90mok\x1b[39m", "dim 이 검정(30)으로 떨어지면 안 보인다");
assert.equal(downgradeAnsi(dark.success + "ok", "none"), "ok", "색 없는 터미널에서는 텍스트만");
assert.equal(downgradeAnsi("이미 16색\x1b[32m", "256"), "이미 16색\x1b[32m", "손대지 않는다");
assert.equal(detectColorMode({ COLORTERM: "truecolor", TERM: "xterm" }), "truecolor");
assert.equal(detectColorMode({ TERM: "screen-256color" }), "256");
assert.equal(detectColorMode({ TERM: "vt100" }), "16");
assert.equal(detectColorMode({}), "none");
// 정상에 색을 쓰지 않는다(색 = 문제 신호가 하나여야 한다)
assert.equal(cacheEmphasis("good"), "quiet");
assert.equal(cacheEmphasis("dim"), "quiet");
assert.equal(cacheEmphasis("warn"), "loud");
assert.equal(cacheEmphasis("bad"), "loud");
// 색 배치: 정상=초록 · warn=노랑 · bad=빨강+bold (주제 무관 16색이 기본)
assert.deepEqual(cachePaint("good"), { kind: "literal", code: 36, bold: true }, "good 는 시안 — 이 터미널의 SGR 32 는 khaki");
assert.deepEqual(cachePaint("warn"), { kind: "literal", code: 33, bold: true });
assert.deepEqual(cachePaint("bad"), { kind: "literal", code: 31, bold: true });
assert.deepEqual(cachePaint("good", "literal", null, 32), { kind: "literal", code: 32, bold: true }, "/live-status cache good green 으로 되돌리기");
assert.deepEqual(cachePaint("dim"), { kind: "none" });
assert.deepEqual(cachePaint("bad", "theme", "error"), { kind: "theme", name: "error", bold: true });
assert.deepEqual(cachePaint("good", "theme", null), { kind: "literal", code: 36, bold: true }, "테마에 색이 없으면 리터럴로");
assert.equal(GOOD_OPTIONS.cyan, 36);


// 푸터 접기(foldLines) — 이걸 붙일 때 앵커가 안 맞아 테스트 없이 "통과"한 적이 있다.
// 통과가 검사한 코드의 결과가 아니라면 통과가 아니다.
import { foldLines } from "./ansi.ts";
const M = "\u0000split\u0000";
const tr = (x, w) => (x.length > w ? x.slice(0, Math.max(0, w - 1)) + "…" : x);
assert.deepEqual(foldLines(["A", "B", M, "C", "D"], " | ", M, 80, tr), ["A | B", "C | D"]);
assert.deepEqual(foldLines(["A", "B"], " | ", M, 80, tr), ["A | B"], "marker 없으면 한 줄");
assert.deepEqual(foldLines([M, "C"], " | ", M, 80, tr), ["C"], "앞줄이 비면 버린다");
// 각 줄은 **자기 폭으로** 잘린다(극단히 좁으면 10컬럼 하한 — 1칸짜리 줄은 숫자를 못 싣는다).
assert.equal(foldLines(["AAAAAAAAAAAAAAAAAAAA", M, "B"], " | ", M, 12, tr)[0], "AAAAAAAAAAA…", "앞줄만 12컬럼으로");
assert.equal(foldLines(["AAAAAAAAAAAAAAAAAAAA", M, "BBBBBBBBBBBBBBBBBBBB"], " | ", M, 12, tr)[1], "BBBBBBBBBBB…", "뒷줄도 따로");
assert.equal(foldLines(["AAAAAAAAAA", M, "B"], " | ", M, 5, tr)[0], "AAAAAAAAAA", "하한 10 덕분에 10자는 남는다");
console.log("  ✓ cache-segment 표시·색·강등·접기·턴당읽기 총 53 케이스");
