# Quota gauges (live endpoints)

5h/7d gauges for Anthropic, Codex, and OpenCode Go; 5h/7d/30d for OpenCode Go monthly and Cline Pass. Endpoints need real credentials, so this check is optional and read-only.

## Sub-features

- Anthropic OAuth usage → 5h/7d used % + reset.
- Codex wham/usage → 5h/7d. 필드 이름이 자주 바뀐다 — 실측은 `rate_limit.primary_window.used_percent`(사용률), 파서는 `src/quota-windows.ts` 한 곳에서 뒤집는다.
- OpenCode Go `GET /zen/go/v1/usage` with the inference key → rolling/weekly/monthly → `5h`/`7d`/`30d` gauges (no dashboard config needed).
- Cline Pass — **두 엔드포인트의 합성** (단일 usage 엔드포인트가 없다):
  - `GET /api/v1/users/me/plan` → `data.plan.entitlements.cline_pass.inferenceCapThreshold` (`last5Hours/last7days/last30days` `UsageCostUSDPerUser`) = 한도
  - `GET /api/v1/users/{uid}/usages?limit=1000` → `data.items[]` (`createdAt`, `costUsd`) = 거래; 30d 를 덮을 때까지만 페이지네이션(상한 10페이지)
  - 사용률 = 창 안 `costUsd` 합 ÷ 한도(같은 costUsd 단위). rolling 창이라 **리셋 꼬리는 없다** (`resetsAt: 0`). 파서는 `clineWindows`, 둘 다 같은 곳에서.

## How to get to it (user POV)

- Footer shows `⚡provider` always, gauges where a quota endpoint answers; `/live-status refresh` forces refetch.

## Driving it with curl

Preconditions: baseline plus the macOS keychain holding the `opencode` password (same key pi uses).

- **Go endpoint.** `curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage` returns 200 with `usage.rolling/weekly/monthly`; all three (5h/7d/30d) must land as gauges.
- **Codex endpoint.** 토큰·계정은 `~/.codex/auth.json` 에서 읽는다(파일에 적지 말고 명령에서 바로).
  `TOK=$(jq -r .tokens.access_token ~/.codex/auth.json); ACC=$(jq -r .tokens.account_id ~/.codex/auth.json); curl -sS -o /tmp/wham.json -w '%{http_code}\n' https://chatgpt.com/backend-api/wham/usage -H "Authorization: Bearer $TOK" -H "ChatGPT-Account-Id: $ACC" -H 'User-Agent: Mozilla/5.0'` → 200 + `rate_limit.primary_window.used_percent`.
- **Cline endpoints.** 키는 keychain 에서: `KEY=$(security find-generic-password -ws 'cline')`. `curl -s -m 10 -H "Authorization: Bearer $KEY" https://api.cline.bot/api/v1/users/me/plan` → 200 + `data.plan.entitlements.cline_pass.inferenceCapThreshold`; `curl -s -m 10 -H "Authorization: Bearer $KEY" 'https://api.cline.bot/api/v1/users/<uid>/usages?limit=1000'` → 200 + `data.items`. 둘이 같아야 게이지 3개(5h/7d/30d)가 뜬다.
- **Proof.** The 200 body head in the transcript.

## Gotchas

- Never store the key in a file or log — read it from the keychain at runtime, `head -c` the body.
- Anthropic `sk-ant-api*` keys have no subscription usage (chip hidden by design, not a failure).
- Missing creds skip the gauge silently. Absence of a gauge is a credential state, not a code failure — assert nothing about it headless.
- `used_percent`(사용률)와 `percent_left`(남은 비율)를 섞으면 게이지가 조용히 사라지고 `/live-status refresh` 는 `no-usage` 를 뱉는다. 필드 이름을 의심하고 픽스처를 먼저 갱신하라.
- Cline 한도와 사용량은 **같은 costUsd 단위**여야 한다(둘 다 `UsageCostUSD`/`costUsd`). 한도가 0 이거나 숫자가 아니면 그 창만 건너뛴다 — 구독이 없으면 세 창 전부가 빈다(`no-plan`).
- Cline usage 갱신은 completion 직후가 아니라 다음 refresh(≤60s)에 반영된다 — 턴을 마친 뒤 한 템포 늦게 올라간다.
