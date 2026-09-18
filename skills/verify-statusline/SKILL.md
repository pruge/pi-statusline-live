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
ls extensions/live-statusline.ts src/cache-segment.ts src/ctx-snapshot.ts src/ctx-cap.ts
```

## Drive

```bash
npm run check  # esbuild, no warnings
npm test       # cache-segment 53 + ctx-snapshot 3 + ctx-cap 17 + quota-windows 8
```

Then the contract checks (commands, not eyeballing):

```bash
# ctx-cap rule: cap ON keeps the catalogue tier, cap OFF opens the real window
node -e "import('./src/ctx-cap.ts').then(m => { const c = m.defaultCtxCap(); console.log(m.resolveWindow(272000,'openai-codex',c), m.resolveWindow(272000,'openai-codex',{...c,enabled:false}), m.resolveWindow(128000,'openai-codex',{...c,enabled:false}), m.resolveWindow(200000,'anthropic',c)); })"
# ctx-snapshot shape: key + TTL twin constant matches the reader side
node -e "import('./src/ctx-snapshot.ts').then(m => console.log(m.snapshotKey({HERDR_PANE_ID:'w9B:p1'}), m.CTX_TTL_MS))"
# quota endpoint (needs the real key in keychain; read-only GET, optional)
curl -s -m 10 -H "Authorization: Bearer $(security find-generic-password -ws 'opencode')" https://opencode.ai/zen/go/v1/usage | head -c 200
```

Manual only: footer rendering and gauge colors inside pi (`/live-status refresh`, `/ctx off` + next turn's `model_select`/compaction threshold, Divider widths). Scripted checks cannot see pixels or drive pi's compaction loop — say so instead of claiming coverage.

The per-session half *is* scriptable — the extension edits the live model window, so a print-mode run shows it:

```bash
# cap in one session, release in that session only, another session stays capped
printf '{"v":1,"cap":272000,"providers":{"opencode-go":1000000}}' > ~/.pi/agent/ctx-window.json
FOOT=extensions/live-statusline.ts
# (1) fresh turn → capped, (2) /ctx off (command, no model call), (3) turn → released,
# (4) /ctx on, (5) turn → capped again. A second --session-id never picks up the release.
pi -p -ne -ns -np -nc -e "$FOOT" --session-id S --model opencode-go/deepseek-v4.1-flash -- "/ctx off"
# the session's own jsonl must contain: customType "ctx-cap" data {"released":true}
grep -o '"customType":"ctx-cap","data":{[^}]*}' ~/.pi/agent/sessions/*/*S*.jsonl
```

Restore `~/.pi/agent/ctx-window.json` to `{"v":1,"cap":272000,"providers":{"openai-codex":1050000}}`
when done (the probe above overwrites it). `pi.appendEntry` only reaches disk once the
session has a turn — a command-only print run creates no session file, so drive the
sequence above (turn → command → turn), not command-only.

## Evidence

Proof is the terminal transcript: clean `check`, `tests 81 pass 0 fail` (cache-segment 53 + 3 + 17 + 8), the snapshot key + TTL line, the ctx-cap rule line, the per-session jsonl `ctx-cap` entry, and (if run) a 200 with `rolling/weekly/monthly` all three landing as `5h`/`7d`/`30d` gauges. Keep it in `artifacts/verify-statusline/<run>.log` via tee.

## Cleanup

Nothing starts, nothing to kill. Sandbox files (if any) go to `$TMPDIR` and are removed in the same command. Proof logs survive in `artifacts/` (git-ignored).

## Helpers

No helper scripts — the drive is `npm run check`, `npm test`, and the two one-liners above, all shown literally. Do not invent a wrapper that hides them.
