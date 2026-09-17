---
name: verify-statusline
description: "Drive pi-statusline-live the way a user does — build check, unit tests, ctx-snapshot contract, live quota spot-check. Use when touching extensions/ or src/, or to prove the footer before a release."
---

# Verify pi-statusline-live

The footer itself is visual (needs an eyeball inside pi), but everything around it runs headless: esbuild check, unit tests, the ctx-snapshot file contract, and the quota endpoints.

## Launch

No server, no build output. Working directory is the package root.

## Doctor

Read-only:

```bash
node --version  # 22+
ls extensions/live-statusline.ts src/cache-segment.ts src/ctx-snapshot.ts
```

## Drive

```bash
npm run check  # esbuild, no warnings
npm test       # cache-segment 53 + ctx-snapshot 3 + quota-windows 8
```

Then the contract checks (commands, not eyeballing):

```bash
# ctx-snapshot shape: key + TTL twin constant matches the reader side
node -e "import('./src/ctx-snapshot.ts').then(m => console.log(m.snapshotKey({HERDR_PANE_ID:'w9B:p1'}), m.CTX_TTL_MS))"
# quota endpoint (needs the real key in keychain; read-only GET, optional)
curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage | head -c 200
```

Manual only: footer rendering and gauge colors inside pi (`/live-status refresh`,Divider widths). Scripted checks cannot see pixels — say so instead of claiming coverage.

## Evidence

Proof is the terminal transcript: clean `check`, `tests 64 pass 0 fail`, the snapshot key + TTL line, and (if run) a 200 with `rolling/weekly/monthly` all three landing as `5h`/`7d`/`30d` gauges. Keep it in `artifacts/verify-statusline/<run>.log` via tee.

## Cleanup

Nothing starts, nothing to kill. Sandbox files (if any) go to `$TMPDIR` and are removed in the same command. Proof logs survive in `artifacts/` (git-ignored).

## Helpers

No helper scripts — the drive is `npm run check`, `npm test`, and the two one-liners above, all shown literally. Do not invent a wrapper that hides them.
