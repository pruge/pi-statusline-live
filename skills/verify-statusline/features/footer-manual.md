# Footer rendering (manual)

Gauge colors, two-line fold, phase chip, and `/live-status` commands need human eyes inside pi. This file marks the boundary of scripted proof.

## Sub-features

- Phase chip (`○ idle` / spinner `think[:level]` / `run` / `tool`).
- Model + thinking level, always-visible `⚡provider` chip, path, git, context/cost/token blocks.
- Gauges: context fullness signal (green→yellow→red), 5h/7d usage blue, 90%+ red.
- `/live-status [on|off|refresh|color|cache]`, `/legend`.

## How to get to it (user POV)

- Look at the pi footer while an agent runs; toggle with `/live-status`.

## Driving it manually

Preconditions: package installed in pi (`pi install <path>` or global link), any session.

- **Phases.** Run an agent turn with thinking + a tool call. Watch the chip move idle → think → run → tool → idle.
- **Gauges.** `/live-status refresh`, then read the 5h/7d bars and reset times against the dashboard.
- **Proof.** A screenshot or a written note of what was seen (e.g. "5h 12% blue, reset 4h"). No pixels, no proof.

## Gotchas

- Terminal color downgrade (truecolor→256→16→none) changes hues — verify on the terminal you ship to, not just Ghostty truecolor.
- Narrow panes fold to two lines by design; a truncated number is a bug, a wrapped line is not.
