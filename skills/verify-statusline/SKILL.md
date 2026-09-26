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
npm test       # cache-segment 53 + quota-windows 16 + cline-token 7
```

Quota endpoint (optional, read-only GET; needs the real key in keychain):

```bash
curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage | head -c 200
```

`pi-ctx` owns context-window policy and `/ctx`. This package only displays the live session window. Check that the context gauge remains visible after loading the footer; run `/live-status refresh` to check the quota refresh command.

## Manual check

Inside a fresh pi session, confirm the footer still shows phase, model, provider, path, git, context, cost, and token data. Run `/live-status refresh` and confirm the active provider's quota text updates when credentials are available. The TUI rendering and colors need an eyeball; headless tests cannot prove pixels.

## Evidence

Keep the terminal transcript in `artifacts/verify-statusline/<run>.log` via `tee`. Evidence includes a clean `check`, 76 passing tests, and (if run) a successful quota response with the expected windows.

## Cleanup

Nothing starts, nothing to kill. Remove sandbox files in the same command that creates them.
