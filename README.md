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
| `context` | mode chip (`🔒slim` dim when the session window is below the native window / `🔓max` warning when it matches) + `% + bar` against the active session model's context window. When pi has no usage yet (right after a compaction) it prints `? ?░░░░░░░░░ ?/200k`, never a confident `0%`. Display-only — `pi-ctx` owns policy |
| `cost` | session USD |
| `tokens` | `↑in ↓out R W` session totals |
| `⚡Anthropic 5h 7d` | Anthropic OAuth usage (`api.anthropic.com/api/oauth/usage`), used % + reset |
| `⚡Codex 5h 7d` | OpenAI Codex (`chatgpt.com/backend-api/wham/usage`), `rate_limit` 의 5h/7d 창, used % + reset |
| `⚡OpenCode Go 5h 7d 30d` | OpenCode Go API key (`/zen/go/v1/usage`; dashboard scrape as fallback). `rolling`/`weekly`/`monthly` → `5h`/`7d`/`30d` gauges |
| `⚡Cline 5h 7d 30d` | ClinePass subscription — `api.cline.bot` `/api/v1/users/me/plan/usage-limits` gives the server-computed `percentUsed` + `resetsAt` per window (five_hour/weekly/monthly). One call, no client-side synthesis |
| `$X spent · $Y left` | APInex wallet — `api.apinex.bond/v1/balance` gives `balance_usd` (wallet) + `api_key.spent_usd` (this key's spend). Money, not a window: text chip, no gauge. Optional `/ $Z cap` when the key has a spend limit |

## Commands

```
/live-status          — show on/off state
/live-status refresh  — force quota refetch now
/live-status on|off   — toggle custom footer (off = native footer back)
```

Context-window policy and the `/ctx` command belong to `pi-ctx`. This extension only
reports the active session model's current window in the footer.

## Context window display

The context gauge reads `ctx.getContextUsage()` and the active model's `contextWindow`.
It does not adjust the model or store slim/max state. `getContextUsage()` answers
`{tokens: null, percent: null}` until the first response after the latest compaction —
pi's own footer prints `?/200k` there, and `src/context-gauge.ts` keeps that distinction
instead of flattening `null` to a `0%` that would claim an empty context. Use `pi-ctx` to change the active
window; the footer then displays the value pi is using.

## Ctx ownership (T06)

There is no shared per-session ctx snapshot file anymore. pi-ctx owns context-window policy
and `/ctx`; this footer reads the live session (`ctx.getContextUsage()` / `ctx.model`)
via pi's public API and displays it. Removing a consumerless file also removes the
60s-tick revert race after `/ctx slim`. See `pi-ctx/docs/PLAN.md` T06.

One thing is still read from pi-ctx: the *definition* of the native window, needed to label
`🔒slim` / `🔓max`. The footer reproduces pi-ctx's precedence — observed store
(`~/.pi/agent/pi-ctx/windows.json`) → provider override (`~/.pi/agent/ctx-window.json`) →
pi's model registry — in `src/native-window.ts`. Reading the registry alone inverts the chip
for exactly the models pi-ctx overrides: `openai-codex` ships 272k in the catalog while the
real window is 1.05M, so `/ctx slim` (272k) compared against the catalog alone looks equal
and prints 🔓max, and `/ctx max` looks "undecidable" and prints nothing. Read-only, mtime
cached, never written — same rule as the Cline bridge token.

## Quota refresh

The `⚡provider` chip and the gauges come from a cached quota state, so the footer
never shows a provider the session has already left. A session replacement — pi-ctx's
`/clear` is the usual one — comes up on the settings-default provider and only then
has its own model restored, so `model_select` fires while the `session_start` fetch
for that default is still in flight. The refresh queue coalesces instead of dropping:
a request that lands mid-flight schedules one follow-up run, and a state whose provider
no longer matches the live `ctx.model.provider` is not applied (the chip falls back to
the live provider, the gauges drop). `src/quota-refresh.ts` owns both rules.

## Credentials

No extra setup — reads what pi already has:

- Anthropic: `~/.pi/agent/auth.json` (`anthropic` OAuth, `/login anthropic`). `sk-ant-api*` keys have no subscription usage → chip hidden.
- Codex: pi auth `openai-codex` + `~/.codex/auth.json` account id.
- OpenCode Go: pi auth `opencode-go` / `opencode` key (or `OPENCODE_API_KEY`) — no setup. Dashboard scrape (`OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`, or `~/.config/opencode/opencode-quota/opencode-go.json`) stays as fallback for keys without API access.
- Cline: pi auth `clinepass` OAuth token (or `CLINE_API_KEY`). Reuses the WorkOS login that `pi-clinepass-provider` stores in `~/.pi/agent/auth.json` / `~/.cline`; the token is read-only here — refreshing it would break the provider's own next refresh (WorkOS refresh tokens are single-use). Needs a ClinePass plan; without a subscription the gauges stay hidden (`no-plan`), which is a subscription state, not a failure.
- APInex: pi auth `apinex` API key (the `!security find-generic-password -ws 'apinex'` command ref is expanded at call time, same as the provider). Balance chip shows for the active `apinex` provider; `APINEX_API_BASE` overrides the endpoint.

## Credits

- UI base: [@wierdbytes/pi-statusline](https://github.com/wierdbytes/pi-wierd-stuff) (MIT)
- Quota endpoints/shape: [@latentminds/pi-quotas](https://github.com/latentminds-ai/pi-quotas) (MIT)

Standalone, zero runtime deps.
