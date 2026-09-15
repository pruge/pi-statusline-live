# Quota gauges (live endpoints)

5h/7d gauges for Anthropic, Codex, and OpenCode Go. Endpoints need real credentials, so this check is optional and read-only.

## Sub-features

- Anthropic OAuth usage → 5h/7d remaining + reset.
- Codex wham/usage → 5h/7d.
- OpenCode Go `GET /zen/go/v1/usage` with the inference key → rolling/weekly/monthly (no dashboard config needed).

## How to get to it (user POV)

- Footer shows `⚡provider` always, gauges where a quota endpoint answers; `/live-status refresh` forces refetch.

## Driving it with curl

Preconditions: baseline plus the macOS keychain holding the `opencode` password (same key pi uses).

- **Go endpoint.** `curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage` returns 200 with `usage.rolling/weekly/monthly`.
- **Proof.** The 200 body head in the transcript.

## Gotchas

- Never store the key in a file or log — read it from the keychain at runtime, `head -c` the body.
- Anthropic `sk-ant-api*` keys have no subscription usage (chip hidden by design, not a failure).
- Missing creds skip the gauge silently. Absence of a gauge is a credential state, not a code failure — assert nothing about it headless.
