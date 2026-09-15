// ctx-snapshot contract tests — key/prune rules. Run: node src/ctx-snapshot.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeKey, snapshotKey, staleNames, CTX_TTL_MS } from "./ctx-snapshot.ts";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

test("snapshotKey — pane 우선, 없으면 세션, 그래도 없으면 pid", () => {
	assert.equal(snapshotKey({ HERDR_PANE_ID: "w9B:p1", PI_SESSION_ID: "abc" }), "w9B:p1");
	assert.equal(snapshotKey({ PI_SESSION_ID: "sess-1" }), "sess-1");
	assert.match(snapshotKey({}), /^pid-\d+$/);
});

test("sanitizeKey — : 살리고 / 는 - 로", () => {
	assert.equal(sanitizeKey("w9B:p1"), "w9B:p1");
	assert.equal(sanitizeKey("a/b"), "a-b");
	assert.equal(sanitizeKey(""), "unknown");
});

test("staleNames — TTL 밖 + 파싱 실패만", () => {
	const out = staleNames([
		{ name: "fresh.json", at: iso(5 * 60_000) },
		{ name: "old.json", at: iso(CTX_TTL_MS + 1000) },
		{ name: "broken.json", at: "not-a-date" },
		{ name: "noat.json" },
	], NOW);
	assert.deepEqual(out.sort(), ["broken.json", "noat.json", "old.json"]);
});
