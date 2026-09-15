# Footer build + units

The extension must compile warning-free and the pure segments must hold their regressions.

## Sub-features

- `npm run check` bundles `extensions/*.ts` with zero warnings.
- `cache-segment` 53 cases (display, color, downgrade, fold, per-turn read).
- `ctx-snapshot` 3 cases (key priority, sanitize, prune selection).

## How to get to it (user POV)

- Install or reload the package in pi; the footer replaces the native one.

## Driving it with npm

Preconditions: baseline.

- **Build.** Run `npm run check`. Require no output past the npm notice lines.
- **Units.** Run `npm test`. Require `pass 56 fail 0` (53 + 3).
- **Proof.** The transcript lines.

## Gotchas

- esbuild warnings are errors here — a new unused import fails the drive.
- Tests import `.ts` directly via node type-stripping (node 22.6+); no build step before tests.
