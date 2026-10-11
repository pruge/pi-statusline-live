---
name: verify-statusline
description: "Drive pi-statusline-live the way a user does: build check, unit tests, and a live quota spot-check. Use when touching extensions/ or src/, or to prove the footer before a release."
---

# Verify pi-statusline-live

The footer itself needs a visual check inside pi. The build, tests, and quota endpoint can run headless.

## Doctor

Read-only:

```bash
node --version  # 22+
ls extensions/live-statusline.ts src/cache-segment.ts
```

## Drive

Run from the package root:

```bash
npm run check  # esbuild, no warnings
npm test       # cache-segment 53 + quota-windows 19 + cline-token 7 (node:test) + cap-chip/native-window assert suites
```

Quota endpoint (optional, read-only GET; needs the real key in keychain):

```bash
curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage | head -c 200
```

`pi-ctx` owns context-window policy and `/ctx`. This package only displays the live session window; for the `🔒slim` / `🔓max` chip it reads pi-ctx's native-window definition (observed store → provider override → registry) read-only, so a slimmed `openai-codex` session shows 🔒slim against its 1.05M override rather than the catalog's 272k. Check that the context gauge remains visible after loading the footer; run `/live-status refresh` to check the quota refresh command.

## Manual check

Inside a fresh pi session, confirm the footer still shows phase, model, provider, path, git, context, cost, and token data. Run `/live-status refresh` and confirm the active provider's quota text updates when credentials are available. The TUI rendering and colors need an eyeball; headless tests cannot prove pixels.

## Evidence

Keep the terminal transcript in `artifacts/verify-statusline/<run>.log` via `tee`. Evidence includes a clean `check`, 79 passing node:test cases (53 + 19 + 7) plus green cap-chip/native-window assert suites, and (if run) a successful quota response with the expected windows.

## Cleanup

Nothing starts, nothing to kill. Remove sandbox files in the same command that creates them.
