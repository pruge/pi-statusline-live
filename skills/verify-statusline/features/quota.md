# Quota gauges (live endpoints)

5h/7d gauges for Anthropic, Codex, and OpenCode Go. Endpoints need real credentials, so this check is optional and read-only.

## Sub-features

- Anthropic OAuth usage → 5h/7d used % + reset.
- Codex wham/usage → 5h/7d. 필드 이름이 자주 바뀐다 — 실측은 `rate_limit.primary_window.used_percent`(사용률), 파서는 `src/quota-windows.ts` 한 곳에서 뒤집는다.
- OpenCode Go `GET /zen/go/v1/usage` with the inference key → rolling/weekly/monthly (no dashboard config needed).

## How to get to it (user POV)

- Footer shows `⚡provider` always, gauges where a quota endpoint answers; `/live-status refresh` forces refetch.

## Driving it with curl

Preconditions: baseline plus the macOS keychain holding the `opencode` password (same key pi uses).

- **Go endpoint.** `curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage` returns 200 with `usage.rolling/weekly/monthly`.
- **Codex endpoint.** 토큰·계정은 `~/.codex/auth.json` 에서 읽는다(파일에 적지 말고 명령에서 바로).
  `TOK=$(jq -r .tokens.access_token ~/.codex/auth.json); ACC=$(jq -r .tokens.account_id ~/.codex/auth.json); curl -sS -o /tmp/wham.json -w '%{http_code}\n' https://chatgpt.com/backend-api/wham/usage -H "Authorization: Bearer $TOK" -H "ChatGPT-Account-Id: $ACC" -H 'User-Agent: Mozilla/5.0'` → 200 + `rate_limit.primary_window.used_percent`.
- **Proof.** The 200 body head in the transcript.

## Gotchas

- Never store the key in a file or log — read it from the keychain at runtime, `head -c` the body.
- Anthropic `sk-ant-api*` keys have no subscription usage (chip hidden by design, not a failure).
- Missing creds skip the gauge silently. Absence of a gauge is a credential state, not a code failure — assert nothing about it headless.
- `used_percent`(사용률)와 `percent_left`(남은 비율)를 섞으면 게이지가 조용히 사라지고 `/live-status refresh` 는 `no-usage` 를 뱉는다. 필드 이름을 의심하고 픽스처를 먼저 갱신하라.
