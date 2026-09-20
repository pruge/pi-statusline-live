// cline-token 계약 테스트 — statusline 이 어떤 Cline 토큰을 쓸지. Run: node src/cline-token.test.mjs
// pi-cline-bridge ↔ pi-statusline-live 의 파일 기반 계약: bridge 가 갱신해 둔 키를
// statusline 이 읽는다. statusline 이 직접 갱신하면 토큰이 회전해 bridge/CLI 가 401 을
// 받으므로, 이 우선순위는 함수가 아니라 계약이다.
import test from "node:test";
import assert from "node:assert/strict";
import { pickClineToken } from "./cline-token.ts";

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

test("pickClineToken — 만료 임박 저장 토큰은 건너뛴다 (갱신은 bridge/CLI 의 몫)", () => {
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
