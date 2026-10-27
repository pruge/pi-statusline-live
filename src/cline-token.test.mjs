// cline-token 계약 테스트 — statusline 이 어떤 Cline 토큰을 쓸지. Run: node src/cline-token.test.mjs
// pi-cline-bridge/pi-clinepass-provider ↔ pi-statusline-live 의 파일 기반 계약:
// client 가 갱신해 둔 키를 statusline 이 읽는다. statusline 이 직접 갱신하면 토큰이
// 회전해 그 client 가 401 을 받으므로, 이 우선순위는 함수가 아니라 계약이다.
import test from "node:test";
import assert from "node:assert/strict";
import { clineTokenCandidates, pickClineToken, probeTokens } from "./cline-token.ts";

const NOW = 1_000_000;

test("pickClineToken — bridge 가 발행한 키가 최우선 (저장 토큰보다 위)", () => {
  assert.equal(
    pickClineToken({ published: { key: "workos:published" }, stored: { access: "workos:stored", expires: NOW + 120_000 } }, NOW),
    "workos:published",
  );
});

test("pickClineToken — 발행 키가 없고 저장 토큰이 신선하면 그것을 쓴다", () => {
  assert.equal(pickClineToken({ stored: { access: "workos:stored", expires: NOW + 120_000 } }, NOW), "workos:stored");
});

test("pickClineToken — 만료 임박 저장 토큰은 건너뛴다 (갱신은 client 의 몫)", () => {
  assert.equal(pickClineToken({ stored: { access: "workos:stale", expires: NOW + 1_000 } }, NOW), undefined);
  assert.equal(pickClineToken({ stored: { access: "workos:expired", expires: NOW - 1_000 } }, NOW), undefined);
});

test("pickClineToken — expires 가 없으면 신선한 것으로 본다", () => {
  assert.equal(pickClineToken({ stored: { access: "workos:noexp" } }, NOW), "workos:noexp");
});

test("pickClineToken — 둘 다 없으면 env API 키", () => {
  assert.equal(pickClineToken({ envApiKey: "sk-static" }, NOW), "sk-static");
});

test("pickClineToken — 아무것도 없으면 undefined (게이지 없음, 실패 아님)", () => {
  assert.equal(pickClineToken({}, NOW), undefined);
});

test("pickClineToken — 발행 키가 빈 문자열이면 무시하고 다음 후보로", () => {
  assert.equal(
    pickClineToken({ published: { key: "" }, stored: { access: "workos:stored" } }, NOW),
    "workos:stored",
  );
});

test("clineTokenCandidates — 발행 키 → pi auth → CLI 저장 → env 순서", () => {
  assert.deepEqual(
    clineTokenCandidates({
      published: { key: "workos:published" },
      piAuth: { access: "workos:pi", expires: NOW + 120_000 },
      stored: { access: "workos:stored", expires: NOW + 120_000 },
      envApiKey: "sk-static",
    }, NOW),
    ["workos:published", "workos:pi", "workos:stored", "sk-static"],
  );
});

test("clineTokenCandidates — pi auth 만 신선하면 발행 키 뒤에 붙는다 (발행 키가 낡았을 수 있다)", () => {
  // 실측: bridge 를 안 돌린 세션에서 발행 키는 401, pi auth clinepass 는 200.
  assert.deepEqual(
    clineTokenCandidates({ published: { key: "workos:stale-published" }, piAuth: { access: "workos:pi", expires: NOW + 44 * 60_000 } }, NOW),
    ["workos:stale-published", "workos:pi"],
  );
});

test("clineTokenCandidates — 만료 임박 pi auth 토큰은 후보에서 빠진다", () => {
  assert.deepEqual(
    clineTokenCandidates({ piAuth: { access: "workos:pi", expires: NOW + 1_000 }, stored: { access: "workos:stored" } }, NOW),
    ["workos:stored"],
  );
});

test("clineTokenCandidates — 같은 토큰은 한 번만 (pi auth == CLI 저장인 경우)", () => {
  assert.deepEqual(
    clineTokenCandidates({ published: { key: "workos:same" }, piAuth: { access: "workos:same" }, stored: { access: "workos:same" } }, NOW),
    ["workos:same"],
  );
});

test("probeTokens — 첫 후보가 답하면 거기서 멈춘다", async () => {
  const asked = [];
  const r = await probeTokens(["a", "b"], async (t) => { asked.push(t); return ["5h"]; });
  assert.deepEqual(asked, ["a"]);
  assert.deepEqual(r, { token: "a", value: ["5h"], answered: true, rejected: 0 });
});

test("probeTokens — 401 난 후보는 건너뛰고 다음 후보로", async () => {
  const r = await probeTokens(["stale", "live"], async (t) => {
    if (t === "stale") throw new Error("HTTP 401");
    return ["5h", "7d"];
  });
  assert.equal(r.token, "live");
  assert.deepEqual(r.value, ["5h", "7d"]);
  assert.equal(r.answered, true);
  assert.equal(r.rejected, 1);
});

test("probeTokens — 200 인데 창이 없으면 다음 후보를 계속 보고, 빈 답을 기억한다", async () => {
  const r = await probeTokens(["no-plan", "paid"], async (t) => (t === "paid" ? ["5h"] : []));
  assert.equal(r.token, "paid");
  assert.deepEqual(r.value, ["5h"]);
  assert.equal(r.answered, true);

  const empty = await probeTokens(["no-plan"], async () => []);
  assert.deepEqual(empty, { token: "no-plan", value: [], answered: true, rejected: 0 });
});

test("probeTokens — 전부 거부되면 answered=false (자격증명 문제) + rejected 수", async () => {
  const r = await probeTokens(["a", "b"], async () => { throw new Error("HTTP 401"); });
  assert.deepEqual(r, { token: undefined, value: [], answered: false, rejected: 2 });
});

test("probeTokens — 후보가 없으면 아무 요청도 하지 않고 빈 결과", async () => {
  let calls = 0;
  const r = await probeTokens([], async () => { calls += 1; return []; });
  assert.equal(calls, 0);
  assert.deepEqual(r, { token: undefined, value: [], answered: false, rejected: 0 });
});

test("probeTokens — 첫 성공이 빈 답이고 뒤가 거부되어도 '답했다'를 유지한다 (no-plan vs 401)", async () => {
  const r = await probeTokens(["no-plan", "stale"], async (t) => {
    if (t === "stale") throw new Error("HTTP 401");
    return [];
  });
  assert.equal(r.token, "no-plan");
  assert.equal(r.answered, true);
  assert.equal(r.rejected, 1);
});
