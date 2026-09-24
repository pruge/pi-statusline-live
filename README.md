# pi-statusline-live

Realtime pi statusline — one package mixing two ideas:

- **Base UI** from [`@wierdbytes/pi-statusline`](https://github.com/wierdbytes/pi-wierd-stuff): one-line widget with `phase │ model[thinking] │ provider │ path │ git │ context │ cost │ tokens`
- **Live quotas** from [`@latentminds/pi-quotas`](https://github.com/latentminds-ai/pi-quotas): realtime `5h / 7d` (Anthropic, Codex), `5h / 7d / monthly` (OpenCode Go), and `5h / 7d / 30d` (Cline Pass), refreshed every 60s + on every turn. The `⚡provider` chip is always visible — quota bars only appear where a quota endpoint exists.

Since 0.2.0 the line lives in the **native footer slot** (`ctx.ui.setFooter`) — pi's built-in `cwd │ tokens` footer is replaced, not duplicated. `/live-status off` restores the native footer.

Gauges: fixed identity colors, all bold — context = cyan, `5h` = yellow, `7d` = green. Any gauge at 90%+ flips red.

Survives `/reload` (singleton released on `session_shutdown`, footer reinstalled on `session_start`). `on/off` state persists across reloads.

```
⠋ think:high │ 🤖 opus-4-8 🧠 high │ ⚡Anthropic 5h 78%[▓▓▓▓▓▓▓░░░] ⏳2h 7d 91%[▓▓▓▓▓▓▓▓▓░] ⏳3d │ …/ai2/pi │ main ✓ │ 12% 8k[▓░░░░░░░░░] 190k left │ $0.42 │ ↑12k ↓8k
```

Thinking level (`🧠 high`) shows next to the model when active; hidden when `off` (non-reasoning models). Busy phase also carries it (`⠋ think:high`).

No-quota provider (e.g. OpenAI, Gemini, Ollama, custom proxies) — `🧠` chip works the same here (shown when level isn't `off`):

```
○ idle │ 🤖 gpt-5.1 🧠 medium │ ⚡OpenAI │ …/ai2/pi │ main ✓ │ 12% 8k[▓░░░░░░░░░] 190k left
```

## Install

```bash
pi install github.com/pruge/pi-statusline-live
# or
pi install npm:pi-statusline-live
```

Try without installing:

```bash
pi -e github.com/pruge/pi-statusline-live
```

## What you get

| Block | Source |
|---|---|
| `○ idle / ⠋ think[:level] / ⠋ run / ⠋ <tool>` | live agent phase (`agent_start` → run, `thinking_*` stream events → think, `tool_execution_*` → tool, `agent_settled` → idle; spinner ticks at 120ms while busy) |
| `🤖 model[ 🧠 level]` | active pi model (shortened) + thinking level (`off` → hidden) |
| `⚡provider` | active provider, always shown (`⚡OpenAI`, `⚡Gemini`, `⚡Ollama`, custom `my-proxy` → `⚡My Proxy`); quota bars appended below when available |
| `path` | last 3 segments of cwd |
| `git` | branch + `✓/✗` dirty |
| `context` | `% + bar` vs model context window, prefixed with the mode chip (`🔒slim` dim / `🔓max` warning) |
| `cost` | session USD |
| `tokens` | `↑in ↓out R W` session totals |
| `⚡Anthropic 5h 7d` | Anthropic OAuth usage (`api.anthropic.com/api/oauth/usage`), used % + reset |
| `⚡Codex 5h 7d` | OpenAI Codex (`chatgpt.com/backend-api/wham/usage`), `rate_limit` 의 5h/7d 창, used % + reset |
| `⚡OpenCode Go 5h 7d 30d` | OpenCode Go API key (`/zen/go/v1/usage`; dashboard scrape as fallback). `rolling`/`weekly`/`monthly` → `5h`/`7d`/`30d` gauges |
| `⚡Cline 5h 7d 30d` | ClinePass subscription — `api.cline.bot` `/api/v1/users/me/plan/usage-limits` gives the server-computed `percentUsed` + `resetsAt` per window (five_hour/weekly/monthly). One call, no client-side synthesis |
| `context` cap | `/ctx max` opens the active model's real window for this session+model; `/ctx slim` keeps the 272k auto-compact cap (default, every model) |

## Commands

```
/live-status          — show on/off state
/live-status refresh  — force quota refetch now
/live-status on|off   — toggle custom footer (off = native footer back)

/ctx                  — context cap status (this session+model's max/slim mode + effective window)
/ctx max              — use this model's real window in THIS session only (per model)
/ctx slim             — back to the 272k cap in THIS session (default, every model)
/ctx toggle           — flip max ↔ slim for the active model
/ctx slim <272k|300k|1m>  — set the GLOBAL default cap (every session) and go slim here
```

## Context cap (`/ctx`) — max / slim, every model, per session+model

pi decides auto-compaction with `contextTokens > model.contextWindow - reserveTokens`,
so the model's **context window** is the only lever that moves the compaction point.
Raising `compaction.reserveTokens` instead would be global (every model compacts every
turn) and would blow the summary output cap up to 128k (`0.8 * reserveTokens`, capped at
`maxTokens`) — so this extension edits the window at runtime via `pi.setModel`.

**slim = min(cap, full)** · **max = full**, where `full` is the catalogue window unless a
provider override says otherwise. Applies to **every model**: a 1M catalogue window
(anthropic, cline, opencode, …) compacts at 272k in slim and opens to its real window on
`/ctx max`. Catalogue windows below the cap (e.g. haiku 200k, spark 128k) are never
touched — slim and max are the same there, so no chip either.

- **slim** (default for every session and every model): `contextWindow = min(cap, full)`,
  auto-compact at `cap − reserveTokens` (~256k with the default 272k cap)
- **max** (this session **and** this model only): `contextWindow = full` (catalogue window,
  or the provider override — codex `gpt-5.x` catalogue says 272k, real window is 1.05M)

Two layers make that work:

| Layer | Where | Scope |
|---|---|---|
| cap + catalogue-override map | `~/.pi/agent/ctx-window.json` | every session (the default) |
| per-model max/slim snapshot | `pi.appendEntry("ctx-cap", { states })` in the session file | just that session |

`states` is `{ "provider/modelId": true|false }` — last snapshot wins, unrecorded models
are slim. The choice survives `/reload` and `--resume` of that session and never leaks to
another session. Old sessions that only stored a session-wide `{ released }` flag still
read that flag until the first `/ctx` writes a `states` snapshot.

The footer says which mode you are in, next to the context gauge — the chip is
`🔒slim` (dim) while capped and `🔓max` (bold warning) once open, and the window
denominator flips `272k` ↔ the real window with it:

```
○ idle │ 🤖 gpt-5.6-sol 🧠 high │ ⚡Codex … │ 🔒slim 24% ▓▓ 65k/272k │ …   # slim (default)
○ idle │ 🤖 gpt-5.6-sol 🧠 high │ ⚡Codex … │ 🔓max 6% ▓ 65k/1.1M │ …     # /ctx max
○ idle │ 🤖 deepseek-v4.1-flash 🧠 high │ ⚡Cline … │ 🔒slim 8% ▓ 80k/272k │ …  # 1M model, slim
```

It repaints on the command itself (no need to wait for the next model response), and the
ctx snapshot for orchestrators is rewritten at the same moment. Models whose full window
is at or below the cap get no chip (slim ≡ max).

```json
{ "v": 1, "cap": 272000, "providers": { "openai-codex": 1050000 } }
```

`providers` only holds **overrides** for catalogue under-reports (codex gpt-5.x: catalogue
272k, real 1.05M) — every other model uses its catalogue window as `full`. With the cap on
and the catalogue already at 272k, no `pi.setModel` call happens at all (no session
churn); opening max on a 1M model leaves one `model_change` + one `ctx-cap` entry in that
one session.

## Ctx registry (for orchestrators)

Every session running this extension snapshots its context to a shared file:

- dir: `~/.pi/agent/ctx-sessions/`, file `<HERDR_PANE_ID ?? PI_SESSION_ID ?? pid>.json`
- shape: `{ v:1, pane?, session?, cwd, model?, provider?, pct, cur, win, at }`
- written on `turn_end` / `model_select` / every 60s tick; stale entries (30min) pruned on write; own file removed on `session_shutdown`

`pi-ticketflow` reads it (`tf_status` worker detail, idle-watch lines), matching workers by pane (`workerPane`) then worktree cwd. File boundary, no imports — see `src/ctx-snapshot.ts`.

## Credentials

No extra setup — reads what pi already has:

- Anthropic: `~/.pi/agent/auth.json` (`anthropic` OAuth, `/login anthropic`). `sk-ant-api*` keys have no subscription usage → chip hidden.
- Codex: pi auth `openai-codex` + `~/.codex/auth.json` account id.
- OpenCode Go: pi auth `opencode-go` / `opencode` key (or `OPENCODE_API_KEY`) — no setup. Dashboard scrape (`OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`, or `~/.config/opencode/opencode-quota/opencode-go.json`) stays as fallback for keys without API access.
- Cline: pi auth `clinepass` OAuth token (or `CLINE_API_KEY`). Reuses the WorkOS login that `pi-clinepass-provider` stores in `~/.pi/agent/auth.json` / `~/.cline`; the token is read-only here — refreshing it would break the provider's own next refresh (WorkOS refresh tokens are single-use). Needs a ClinePass plan; without a subscription the gauges stay hidden (`no-plan`), which is a subscription state, not a failure.

## Credits

- UI base: [@wierdbytes/pi-statusline](https://github.com/wierdbytes/pi-wierd-stuff) (MIT)
- Quota endpoints/shape: [@latentminds/pi-quotas](https://github.com/latentminds-ai/pi-quotas) (MIT)

Standalone, zero runtime deps.
