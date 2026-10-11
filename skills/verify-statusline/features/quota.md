# Quota gauges (live endpoints)

5h/7d gauges for Anthropic, Codex, and OpenCode Go; 5h/7d/30d for OpenCode Go monthly and Cline Pass. Endpoints need real credentials, so this check is optional and read-only.

## Sub-features

- Anthropic OAuth usage → 5h/7d used % + reset.
- Codex wham/usage → 5h/7d. 필드 이름이 자주 바뀐다 — 실측은 `rate_limit.primary_window.used_percent`(사용률), 파서는 `src/quota-windows.ts` 한 곳에서 뒤집는다.
- OpenCode Go `GET /zen/go/v1/usage` with the inference key → rolling/weekly/monthly → `5h`/`7d`/`30d` gauges (no dashboard config needed).
- Cline Pass — `GET /api/v1/users/me/plan/usage-limits` (단일 엔드포인트): 서버가
  `data.limits[]` 에 `type`(five_hour/weekly/monthly)·`percentUsed`(사용률)·`resetsAt`
  를 직접 준다 → `5h`/`7d`/`30d` 게이지 + 리셋 꼬리. **한도×거래 합성은 쓰지 않는다** —
  클라에서 합성하면 비구독(usage-billing) 사용량까지 끌어와 홈페이지보다 크게
  나온다(실측: 18% vs 홈페이지 0%). 파서는 `clineWindows`, 한 곳.
- APInex — `GET https://api.apinex.bond/v1/balance`: 시간 창이 아니라 **돈**이라 게이지가
  아니라 텍스트 칩(`$0.02 spent · $3.10 left`). `balance_usd`(지갑) +
  `api_key.spent_usd`(키별 사용량), 한도를 걸었을 때만 `spend_limit_usd` → ` / $Z cap`
  (도달하면 빨강). 파서는 `apinexBalance`, 한 곳.

## How to get to it (user POV)

- Footer shows `⚡provider` always, gauges where a quota endpoint answers; `/live-status refresh` forces refetch.

## Driving it with curl

Preconditions: baseline plus the macOS keychain holding the `opencode` password (same key pi uses).

- **Go endpoint.** `curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage` returns 200 with `usage.rolling/weekly/monthly`; all three (5h/7d/30d) must land as gauges.
- **Codex endpoint.** 토큰·계정은 `~/.codex/auth.json` 에서 읽는다(파일에 적지 말고 명령에서 바로).
  `TOK=$(jq -r .tokens.access_token ~/.codex/auth.json); ACC=$(jq -r .tokens.account_id ~/.codex/auth.json); curl -sS -o /tmp/wham.json -w '%{http_code}\n' https://chatgpt.com/backend-api/wham/usage -H "Authorization: Bearer $TOK" -H "ChatGPT-Account-Id: $ACC" -H 'User-Agent: Mozilla/5.0'` → 200 + `rate_limit.primary_window.used_percent`.
- **Cline endpoint.** 키는 `~/.pi/agent/auth.json` 의 clinepass OAuth(`workos:` 접두) 또는 keychain: `curl -s -m 10 -H "Authorization: Bearer $(jq -r .clinepass.access ~/.pi/agent/auth.json)" https://api.cline.bot/api/v1/users/me/plan/usage-limits` → 200 + `data.limits[]` 세 창. `percentUsed` 가 **사용률**임에 주의 (남은 비율이 아니다).
- **APInex endpoint.** 키는 keychain `apinex`(auth.json 의 `!command` 참조와 같은 것): `curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'apinex')" https://api.apinex.bond/v1/balance` → 200 + `balance_usd` / `api_key.spent_usd`. 잔액 0 + `free/*` 모델은 `allowFree=false` 면 402 `billing_error`(구독 필요) — 잔액 칩은 그와 무관하게 뜬다.
- **Proof.** The 200 body head in the transcript.

## Gotchas

- Never store the key in a file or log — read it from the keychain at runtime, `head -c` the body.
- Anthropic `sk-ant-api*` keys have no subscription usage (chip hidden by design, not a failure).
- Missing creds skip the gauge silently. Absence of a gauge is a credential state, not a code failure — assert nothing about it headless.
- `used_percent`(사용률)와 `percent_left`(남은 비율)를 섞으면 게이지가 조용히 사라지고 `/live-status refresh` 는 `no-usage` 를 뱉는다. 필드 이름을 의심하고 픽스처를 먼저 갱신하라.
- Cline 한도와 사용량은 **같은 costUsd 단위**여야 한다(둘 다 `UsageCostUSD`/`costUsd`). 한도가 0 이거나 숫자가 아니면 그 창만 건너뛴다 — 구독이 없으면 세 창 전부가 빈다(`no-plan`).
- Cline usage 갱신은 completion 직후가 아니라 다음 refresh(≤60s)에 반영된다 — 턴을 마친 뒤 한 템포 늦게 올라간다.
- **Cline 은 합성하지 마라** — 처음에 plan(한도) ÷ usages(거래) 로 클라에서 계산했더니 비구독 사용량까지 들어와 홈페이지(0%)와 18% 가 어긋났다. `percentUsed` 를 서버에서 받아쓰는 게 정답. 한때 `usages` 집계가 정답인 줄 알고 달렸다 — 클라 계산이 서버 판정과 같다는 증거가 없으면 의심하라.
