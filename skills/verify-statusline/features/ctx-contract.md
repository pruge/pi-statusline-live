# Ctx-snapshot contract (writer side)

`src/ctx-snapshot.ts` is the writer half of the file contract with pi-ticketflow (reader). Shape, key, and TTL must match `README.md`'s "Ctx registry" section on both sides.

## Sub-features

- `snapshotKey` prefers `HERDR_PANE_ID`, then `PI_SESSION_ID`, then `pid-<pid>`.
- `sanitizeKey` keeps `:` (pane ids), maps everything else unsafe to `-`.
- `staleNames` selects TTL-outside plus unparseable `at`.
- `CTX_TTL_MS` is 30 minutes — the twin constant in ticketflow (`CTX_SNAPSHOT_TTL_MS`) must say the same.

## How to get to it (user POV)

- Any pi session with the extension writes `~/.pi/agent/ctx-sessions/<key>.json` on turn end and every 60s.

## Driving it with node

Preconditions: baseline.

- **Key.** `node -e "import('./src/ctx-snapshot.ts').then(m => console.log(m.snapshotKey({HERDR_PANE_ID:'w9B:p1'}), m.CTX_TTL_MS))"` prints `w9B:p1 1800000`.
- **Prune rule.** Covered by the 3 unit cases in `npm test`.
- **Proof.** The printed key + TTL line.

## Gotchas

- The two TTL constants live in different repos. Changing one without the other silently splits the contract — the drive asserts this side's value; the reader side asserts its own in its skill.
- Writer failures must never break the footer (best-effort everywhere). A test that throws out of the writer path fails the drive.
