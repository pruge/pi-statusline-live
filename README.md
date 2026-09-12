# pi-statusline-live

Realtime pi statusline — one package mixing two ideas:

- **Base UI** from [`@wierdbytes/pi-statusline`](https://github.com/wierdbytes/pi-wierd-stuff): one-line widget with `phase │ model │ path │ git │ context │ cost │ tokens`
- **Live quotas** from [`@latentminds/pi-quotas`](https://github.com/latentminds-ai/pi-quotas): realtime `5h / 7d` (Anthropic, Codex) and `5h / weekly` (OpenCode Go), refreshed every 60s + on every turn

Since 0.2.0 the line lives in the **native footer slot** (`ctx.ui.setFooter`) — pi's built-in `cwd │ tokens` footer is replaced, not duplicated. `/live-status off` restores the native footer.

```
⠋ think:high │ 🤖 opus-4-8 │ …/ai2/pi │ main ✓ │ 12%:8k[▓░░░░░░░░░]190k │ $0.42 │ ↑12k ↓8k │ ⚡An 5h:78%↺2h 7d:91%↺3d
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
| `🤖 model` | active pi model (shortened) |
| `path` | last 3 segments of cwd |
| `git` | branch + `✓/✗` dirty |
| `context` | `% + bar` vs model context window |
| `cost` | session USD |
| `tokens` | `↑in ↓out R W` session totals |
| `⚡An 5h 7d` | Anthropic OAuth usage (`api.anthropic.com/api/oauth/usage`), remaining % + reset |
| `⚡Cx 5h 7d` | OpenAI Codex (`chatgpt.com/backend-api/wham/usage`) |
| `⚡Go 5h 7d` | OpenCode Go dashboard scrape |

Colors shift green → yellow → red as quota drops below 25% / 10%.

## Commands

```
/live-status          — show on/off state
/live-status refresh  — force quota refetch now
/live-status on|off   — toggle custom footer (off = native footer back)
```

## Credentials

No extra setup — reads what pi already has:

- Anthropic: `~/.pi/agent/auth.json` (`anthropic` OAuth, `/login anthropic`). `sk-ant-api*` keys have no subscription usage → chip hidden.
- Codex: pi auth `openai-codex` + `~/.codex/auth.json` account id.
- OpenCode Go: `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`, or `~/.config/opencode/opencode-quota/opencode-go.json`.

## Credits

- UI base: [@wierdbytes/pi-statusline](https://github.com/wierdbytes/pi-wierd-stuff) (MIT)
- Quota endpoints/shape: [@latentminds/pi-quotas](https://github.com/latentminds-ai/pi-quotas) (MIT)

Standalone, zero runtime deps.
