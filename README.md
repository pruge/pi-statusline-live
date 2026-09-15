# pi-statusline-live

Realtime pi statusline — one package mixing two ideas:

- **Base UI** from [`@wierdbytes/pi-statusline`](https://github.com/wierdbytes/pi-wierd-stuff): one-line widget with `phase │ model[thinking] │ provider │ path │ git │ context │ cost │ tokens`
- **Live quotas** from [`@latentminds/pi-quotas`](https://github.com/latentminds-ai/pi-quotas): realtime `5h / 7d` (Anthropic, Codex) and `5h / weekly` (OpenCode Go), refreshed every 60s + on every turn. The `⚡provider` chip is always visible — quota bars only appear where a quota endpoint exists.

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
| `context` | `% + bar` vs model context window |
| `cost` | session USD |
| `tokens` | `↑in ↓out R W` session totals |
| `⚡Anthropic 5h 7d` | Anthropic OAuth usage (`api.anthropic.com/api/oauth/usage`), remaining % + reset |
| `⚡Codex 5h 7d` | OpenAI Codex (`chatgpt.com/backend-api/wham/usage`) |
| `⚡OpenCode Go 5h 7d` | OpenCode Go API key (`/zen/go/v1/usage`; dashboard scrape as fallback) |

## Commands

```
/live-status          — show on/off state
/live-status refresh  — force quota refetch now
/live-status on|off   — toggle custom footer (off = native footer back)
```

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

## Credits

- UI base: [@wierdbytes/pi-statusline](https://github.com/wierdbytes/pi-wierd-stuff) (MIT)
- Quota endpoints/shape: [@latentminds/pi-quotas](https://github.com/latentminds-ai/pi-quotas) (MIT)

Standalone, zero runtime deps.
