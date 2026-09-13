/**
 * pi-statusline-live
 *
 * Mix of:
 *  - @wierdbytes/pi-statusline (base UI: model / path / git / context / cost / tokens)
 *  - @latentminds/pi-quotas (realtime quota fetch: Anthropic 5h/7d, Codex 5h/7d, OpenCode Go 5h/weekly)
 *
 * 0.2.0: the line moved into the native footer slot via ctx.ui.setFooter()
 * (replaces pi's built-in `cwd │ tokens` footer). Above-editor widget removed.
 * A live phase chip leads the line: idle / think / run / tool.
 *
 * Realtime: footer repaints on phase events + quota refresh (60s + turn_end /
 * model_select / session_start). No dependency on either package — standalone.
 */

import { cacheRatio, cacheReadSuffix, cacheTone, cachePaint, colorForTone, GOOD_OPTIONS } from "../src/cache-segment.ts";
import { detectColorMode, downgradeAnsi, paintLiteral } from "../src/ansi.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ── config ──
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const GIT_CACHE_MS = 5_000;
const SPIN_MS = 120;
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── types ──
type Phase = "idle" | "think" | "run" | "tool";
type QuotaChip = { label: string; remainPct: number; resetsAt: number; limited?: boolean };
type QuotaState = {
  at: number;
  chips: QuotaChip[];
  error?: string;
  provider?: string;
};

// ── gauges: fixed identity colors (strong + distinct), red when critical ──
// context → cyan (borderAccent), 5h → yellow (warning), 7d → green (success).
// % numbers share the bar color; any gauge >= 90% flips to error (red).
const GAUGE_CRIT = 90;
type GaugeColor = "borderAccent" | "warning" | "success" | "error";
function gaugeColor(label: string, used: number): GaugeColor {
  if (used >= GAUGE_CRIT) return "error";
  if (label === "5h") return "warning";
  if (label === "7d") return "success";
  return "borderAccent"; // context + fallback
}
function gaugeBar(t: any, label: string, usedPct: number): string {
  const used = Math.max(0, Math.min(100, Math.round(usedPct)));
  const col = gaugeColor(label, used);
  const filled = Math.floor((used * 10) / 100);
  return t.bold(t.fg(col, "▓".repeat(filled))) + t.fg("dim", "░".repeat(10 - filled));
}
function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}
/** 창 크기는 "1.0M" 보다 "1M" 로 읽힌다(같은 숫자를 두 번 보지 않게). */
/** 색 강등 모드: /live-status color <m> 또는 PI_STATUSLINE_COLOR 가 감지보다 앞선다. */
export function resolveColorMode(): string {
	const g = globalThis as any;
	const forced = g[COLOR_MODE_KEY] ?? process.env.PI_STATUSLINE_COLOR;
	if (forced === "truecolor" || forced === "256" || forced === "16" || forced === "none") return forced;
	return detectColorMode(process.env);
}
function fmtWin(n: number): string {
  return fmtTokens(n).replace(/\.0(M|k)$/, "$1");
}
function shortenPath(cwd: string): string {
  const s = cwd.split("/");
  if (s.length <= 3) return cwd;
  return `…/${s[s.length - 3]}/${s[s.length - 2]}/${s[s.length - 1]}`;
}
function providerLabel(p?: string): string {
  if (!p) return "?";
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    "openai-codex": "Codex",
    openai: "OpenAI",
    opencode: "OpenCode Zen",
    "opencode-go": "OpenCode Go",
    google: "Gemini",
    xai: "xAI",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    groq: "Groq",
    cerebras: "Cerebras",
    nvidia: "NVIDIA",
    openrouter: "OpenRouter",
    "github-copilot": "Copilot",
    github_copilot: "Copilot",
    copilot: "Copilot",
    "amazon-bedrock": "Bedrock",
    "azure-openai-responses": "Azure",
    "cloudflare-ai-gateway": "CF Gateway",
    "cloudflare-workers-ai": "CF Workers",
    "vercel-ai-gateway": "Vercel",
    fireworks: "Fireworks",
    together: "Together",
    baseten: "Baseten",
    huggingface: "HF",
    zai: "ZAI",
    "zai-coding-cn": "ZAI CN",
    kimi: "Kimi",
    "kimi-coding": "Kimi",
    minimax: "MiniMax",
    "minimax-cn": "MiniMax CN",
    "qwen-token-plan": "Qwen",
    "qwen-token-plan-individual": "Qwen",
    "qwen-token-plan-cn": "Qwen CN",
    xiaomi: "MiMo",
    "xiaomi-token-plan-cn": "MiMo CN",
    "xiaomi-token-plan-ams": "MiMo AMS",
    "xiaomi-token-plan-sgp": "MiMo SGP",
    "ant-ling": "Ant Ling",
    radius: "Radius",
    ollama: "Ollama",
  };
  if (known[p]) return known[p];
  return p.split(/[-_]/).map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)).join(" ");
}
function shortenModel(m: { id?: string; name?: string } | undefined): string {
  let n = m?.name || m?.id || "no-model";
  if (n.startsWith("Claude ")) n = n.slice(7);
  if (n.startsWith("anthropic/")) n = n.slice(10);
  return n;
}
function fmtReset(resetsAt: number): string {
  if (!resetsAt) return "";
  const ms = resetsAt - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── git (cached) ──
let gitCache = { at: 0, cwd: "", branch: null as string | null, dirty: false };
function getGit(cwd: string) {
  const now = Date.now();
  if (gitCache.cwd === cwd && now - gitCache.at < GIT_CACHE_MS) return gitCache;
  let branch: string | null = null;
  let dirty = false;
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { branch = null; }
  if (branch) {
    try {
      const out = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      dirty = out.trim().length > 0;
    } catch { /* keep clean */ }
  }
  gitCache = { at: now, cwd, branch, dirty };
  return gitCache;
}

// ── session stats (wierd-style gatherStats) ──
function gatherStats(ctx: ExtensionContext) {
  let cost = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if ((e as any).type === "message" && (e as any).message?.role === "assistant") {
        const u = (e as any).message.usage;
        if (!u) continue;
        cost += u.cost?.total ?? 0;
        input += u.input ?? 0;
        output += u.output ?? 0;
        cacheRead += u.cacheRead ?? 0;
        cacheWrite += u.cacheWrite ?? 0;
      }
    }
  } catch { /* session not ready */ }
  return { cost, input, output, cacheRead, cacheWrite };
}

// ── auth resolution ──
function readJson(path: string): any | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
async function anthropicToken(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const r: any = ctx.modelRegistry as any;
    const t = await r?.authStorage?.getApiKey?.("anthropic")
      ?? await r?.getApiKeyForProvider?.("anthropic")
      ?? (await r?.getProviderAuth?.("anthropic"))?.auth?.apiKey;
    if (t) return t;
  } catch { /* fall through */ }
  const auth = readJson(join(homedir(), ".pi", "agent", "auth.json"));
  const cred = auth?.anthropic;
  if (typeof cred === "string") return cred;
  if (cred?.access) return cred.access;
  if (cred?.key) return cred.key;
  return undefined;
}
async function codexCreds(ctx: ExtensionContext): Promise<{ token?: string; accountId?: string }> {
  let token: string | undefined;
  try {
    const r: any = ctx.modelRegistry as any;
    token = await r?.authStorage?.getApiKey?.("openai-codex") ?? await r?.getApiKeyForProvider?.("openai-codex");
    const stored = r?.authStorage?.get?.("openai-codex") as any;
    if (stored?.accountId) return { token, accountId: stored.accountId };
  } catch { /* ignore */ }
  if (!token) {
    const auth = readJson(join(homedir(), ".pi", "agent", "auth.json"));
    token = auth?.["openai-codex"]?.key ?? auth?.["openai-codex"]?.access;
  }
  let accountId: string | undefined;
  const codexAuth = readJson(join(homedir(), ".codex", "auth.json"));
  accountId = codexAuth?.tokens?.account_id ?? codexAuth?.tokens?.accountId;
  if (!token) token = codexAuth?.tokens?.access_token ?? codexAuth?.tokens?.accessToken;
  return { token, accountId };
}
function opencodeGoConfig(): { workspaceId: string; authCookie: string } | null {
  const w = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const c = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (w && c) return { workspaceId: w, authCookie: c };
  for (const p of [
    join(homedir(), ".config", "opencode", "opencode-quota", "opencode-go.json"),
    join(homedir(), ".config", "opencode-go", "config.json"),
  ]) {
    const j = readJson(p);
    if (j?.workspaceId && j?.authCookie) return { workspaceId: j.workspaceId, authCookie: j.authCookie };
  }
  return null;
}

// ── fetch ──
async function fetchJson(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const combined = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  const res = await fetch(url, { headers, signal: combined });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function toMs(v: unknown): number {
  if (typeof v === "number") return v > 1e11 ? v : v * 1000;
  if (typeof v === "string") return new Date(v).getTime();
  return 0;
}
async function fetchAnthropic(token?: string): Promise<QuotaChip[]> {
  if (!token || token.startsWith("sk-ant-api")) return [];
  const d: any = await fetchJson("https://api.anthropic.com/api/oauth/usage",
    { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" });
  const out: QuotaChip[] = [];
  if (d?.five_hour) out.push({ label: "5h", remainPct: Math.max(0, 100 - Number(d.five_hour.utilization ?? 0)), resetsAt: toMs(d.five_hour.resets_at) });
  if (d?.seven_day) out.push({ label: "7d", remainPct: Math.max(0, 100 - Number(d.seven_day.utilization ?? 0)), resetsAt: toMs(d.seven_day.resets_at) });
  return out;
}
async function fetchCodex(token?: string, accountId?: string): Promise<QuotaChip[]> {
  if (!token || !accountId) return [];
  const d: any = await fetchJson("https://chatgpt.com/backend-api/wham/usage",
    { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json", Origin: "https://chatgpt.com", Referer: "https://chatgpt.com/", "User-Agent": "Mozilla/5.0" });
  const rl = d?.rate_limit ?? d?.rate_limits ?? {};
  const out: QuotaChip[] = [];
  const pct = (l: any) => l?.percent_left != null ? Number(l.percent_left) : l?.remaining_percent != null ? Number(l.remaining_percent) : null;
  const prim = rl.primary_window ?? rl.primary ?? rl.five_hour;
  const sec = rl.secondary_window ?? rl.secondary ?? rl.weekly;
  if (prim && pct(prim) != null) out.push({ label: "5h", remainPct: Math.max(0, pct(prim)!), resetsAt: toMs(prim.reset_at ?? prim.reset_time_ms) });
  if (sec && pct(sec) != null) out.push({ label: "7d", remainPct: Math.max(0, pct(sec)!), resetsAt: toMs(sec.reset_at ?? sec.reset_time_ms) });
  return out;
}
async function fetchOpenCodeGo(): Promise<QuotaChip[]> {
  const cfg = opencodeGoConfig();
  if (!cfg) return [];
  const url = `https://opencode.ai/workspace/${encodeURIComponent(cfg.workspaceId)}/go`;
  const combined = AbortSignal.any([AbortSignal.timeout(10000)]);
  const res = await fetch(url, { headers: { Cookie: cfg.authCookie, "User-Agent": "Mozilla/5.0" }, signal: combined });
  if (!res.ok) throw new Error(`Go HTTP ${res.status}`);
  const html = await res.text();
  const grab = (key: string): { pct: number; resetSec: number } | null => {
    const m1 = new RegExp(`${key}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:(-?\\d+(?:\\.\\d+)?)[^}]*resetInSec:(-?\\d+(?:\\.\\d+)?)[^}]*\\}`).exec(html)
      ?? new RegExp(`${key}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:(-?\\d+(?:\\.\\d+)?)[^}]*usagePercent:(-?\\d+(?:\\.\\d+)?)[^}]*\\}`).exec(html);
    if (!m1) return null;
    // order depends on which regex matched — normalize: first alternative is (pct, reset), second is (reset, pct)
    const a = Number(m1[1]), b = Number(m1[2]);
    const isPctFirst = m1[0].indexOf("usagePercent") < m1[0].indexOf("resetInSec");
    return isPctFirst ? { pct: a, resetSec: b } : { pct: b, resetSec: a };
  };
  const out: QuotaChip[] = [];
  const r = grab("rollingUsage");
  if (r) out.push({ label: "5h", remainPct: Math.max(0, 100 - r.pct), resetsAt: Date.now() + Math.max(0, r.resetSec) * 1000 });
  const w = grab("weeklyUsage");
  if (w) out.push({ label: "7d", remainPct: Math.max(0, 100 - w.pct), resetsAt: Date.now() + Math.max(0, w.resetSec) * 1000 });
  return out;
}

// per-provider cache (anthropic 5min, others 60s)
const quotaCache = new Map<string, QuotaState>();
const TTL: Record<string, number> = { anthropic: 5 * 60_000, "openai-codex": 60_000, "opencode-go": 60_000 };

async function refreshQuotas(ctx: ExtensionContext, force = false): Promise<QuotaState> {
  const provider = (() => { try { return ctx.model?.provider; } catch { return undefined; } })();
  const key = provider ?? "none";
  const now = Date.now();
  const cached = quotaCache.get(key);
  if (!force && cached && now - cached.at < (TTL[key] ?? 60_000)) return cached;

  let state: QuotaState = { at: now, chips: [], provider };
  try {
    if (provider === "anthropic") {
      state.chips = await fetchAnthropic(await anthropicToken(ctx));
      if (state.chips.length === 0) state.error = "no-oauth";
    } else if (provider === "openai-codex") {
      const { token, accountId } = await codexCreds(ctx);
      state.chips = await fetchCodex(token, accountId);
      if (state.chips.length === 0) state.error = "no-creds";
    } else if (provider === "opencode" || provider === "opencode-go") {
      state.chips = await fetchOpenCodeGo();
      if (state.chips.length === 0) state.error = "no-go-config";
    } else {
      // background: still try anthropic so switching back is instant — but don't show
      state.chips = [];
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message.slice(0, 80) : "fetch-fail";
    // keep last good chips on transient failure
    if (cached?.chips.length) state.chips = cached.chips;
  }
  state.at = Date.now();
  quotaCache.set(key, state);
  return state;
}

// ── phase chip ──
function renderPhase(t: any, phase: Phase, toolName: string, thinkLevel: string, tick: number): string {
  if (phase === "idle") return t.fg("dim", "○ idle");
  const frame = SPIN_FRAMES[tick % SPIN_FRAMES.length];
  if (phase === "think") {
    const lvl = thinkLevel && thinkLevel !== "off" ? `:${thinkLevel}` : "";
    return t.fg("warning", `${frame} think${lvl}`);
  }
  if (phase === "tool") return t.fg("accent", `${frame} ${toolName || "tool"}`);
  return t.fg("accent", `${frame} run`);
}

// ── render (footer line) ──
function renderLine(
  ctx: ExtensionContext, width: number, quota: QuotaState,
  phase: Phase, toolName: string, thinkLevel: string, tick: number,
): string {
  const t = ctx.ui.theme;
  const stats = gatherStats(ctx);
  let ctxPct = -1, ctxCur = 0, ctxWin = 0;
  try {
    const u = ctx.getContextUsage();
    if (u) { ctxWin = u.contextWindow ?? ctx.model?.contextWindow ?? 0; ctxCur = u.tokens ?? 0; ctxPct = ctxWin > 0 ? Math.floor((ctxCur * 100) / ctxWin) : -1; }
    else { ctxWin = ctx.model?.contextWindow ?? 0; }
  } catch { /* ignore */ }

  const parts: string[] = [renderPhase(t, phase, toolName, thinkLevel, tick)];
  // model + thinking level
  const lvl = thinkLevel && thinkLevel !== "off" ? t.fg("dim", ` 🧠 ${thinkLevel}`) : "";
  parts.push(t.fg("accent", `🤖 ${shortenModel(ctx.model)}`) + lvl);
  // ── LIVE quotas (right after model/thinking) + always-visible provider tag ──
  // Quota bars only exist for Anthropic / Codex / OpenCode Go, but the ⚡provider
  // chip renders for every provider so the active provider is always visible.
  const activeProvider = quota.provider ?? (() => { try { return ctx.model?.provider; } catch { return undefined; } })();
  if (quota.chips.length > 0) {
    const q = quota.chips.map((c) => {
      const used = Math.max(0, Math.min(100, Math.round(100 - c.remainPct)));
      const remain = Math.max(0, Math.min(100, Math.round(c.remainPct)));
      const col = gaugeColor(c.label, used);
      const reset = c.resetsAt ? t.fg("dim", ` ⏳ ${fmtReset(c.resetsAt)}`) : "";
      return t.fg("dim", `${c.label} `) + t.bold(t.fg(col, `${used}%`)) + t.fg("dim", "[") + gaugeBar(t, c.label, used) + t.fg("dim", "]") + t.fg("dim", `${remain}%`) + reset;
    }).join(t.fg("dim", " "));
    parts.push(t.fg("accent", `⚡${providerLabel(activeProvider)} `) + q);
  } else if (activeProvider) {
    parts.push(t.fg("accent", `⚡${providerLabel(activeProvider)}`));
  }
  // path
  try {
    const sp = shortenPath(ctx.cwd);
    parts.push(t.fg("dim", `${dirname(sp)}/`) + t.fg("accent", basename(sp) || sp));
  } catch { /* ignore */ }
  // git
  try {
    const g = getGit(ctx.cwd);
    if (g.branch) parts.push(t.fg("accent", g.branch) + " " + (g.dirty ? t.fg("error", "✗") : t.fg("success", "✓")));
  } catch { /* ignore */ }
  // context (cyan, bold; red when critical)
  if (ctxWin > 0 && ctxPct >= 0) {
    const col = gaugeColor("ctx", ctxPct);
    // 창 대비 사용량 하나를 두 번 말하지 않는다(백분율 + 게이지 + "남은 토큰") → "24% [▓▓░░] 236k/1M"
    parts.push(t.bold(t.fg(col, `${ctxPct}%`)) + t.fg("dim", " [") + gaugeBar(t, "ctx", ctxPct) + t.fg("dim", `] ${fmtTokens(ctxCur)}/`) + t.fg("accent", fmtWin(ctxWin)));
  }
  // cost
  if (stats.cost > 0) parts.push(t.fg("dim", `$${stats.cost.toFixed(2)}`));
  // tokens
  // 토큰·캐시는 하나의 조각으로 합친다 — parts 는 " │ " 로 join 되므로 따로 push 하면
  // ↑ ↓ 와 R 사이에 세로줄이 생겨 한 그룹으로 안 읽힌다(실측: "↓671k │ R255.8M·89%").
  const tok: string[] = [];
  if (stats.input > 0) tok.push(`↑${fmtTokens(stats.input)}`);
  if (stats.output > 0) tok.push(`↓${fmtTokens(stats.output)}`);
  // 캐시 히트율은 R 에 접미어로(별도 조각은 좁은 판에서 잘린다). 색이 판정이다:
  // 85%↑ success · 60%↑ warning · 아래 error = 브리핑·도구블록·TTL 규칙 중 하나를 어기고 있다.
  const rTone = cacheTone(cacheRatio(stats));
  const rw = cacheReadSuffix(stats, rTone);
  // 색 배치(주제 무관 16색, bad 만 bold): 85%↑ 초록 · 60%↑ 노랑+! · 아래 빨강+!!(+W↑)
  // 테마 경유가 필요하면 /live-status cache theme — dark 의 success(#b5bd68) 는 text 와 구별이 안 된다.
  const cacheMode = ((globalThis as any)[CACHE_COLOR_MODE_KEY] ?? "literal") === "theme" ? "theme" : "literal";
  const paint = cachePaint(rTone, cacheMode, cacheMode === "theme" ? colorForTone(t, rTone) : undefined, (globalThis as any)[CACHE_GOOD_CODE_KEY]);
  const seg: string[] = [];
  if (tok.length) seg.push(t.fg("dim", tok.join(" ")));
  const rTxt = `R${fmtTokens(stats.cacheRead || 0)}${rw}`;
  if (rw) {
    if (paint.kind === "literal") seg.push(paintLiteral(paint.code, rTxt, paint.bold));
    else if (paint.kind === "theme") seg.push(paint.bold ? t.bold(t.fg(paint.name, rTxt)) : t.fg(paint.name, rTxt));
    else seg.push(t.fg("dim", rTxt));
  }
  if (stats.cacheWrite > 0) seg.push(t.fg("dim", `W${fmtTokens(stats.cacheWrite)}`));
  if (seg.length) parts.push(seg.join(" "));

  const sep = t.fg("dim", " │ ");
  // 테마가 truecolor 로 내는 색을 터미널/중간 계층(herdr·tmux·구 TERM)이 삼키면
  // 전부 "일반 텍스트 색"으로 뜬다. 그 경우엔 256/16 으로 강등해 보낸다(판정이 색에만 실리면 안 된다).
  return downgradeAnsi(truncateToWidth(parts.join(sep), width), resolveColorMode());
}

// ── extension ──
// Singleton guard: this package can be loaded twice — once as a global package
// (settings.json → packages) and once project-local when running pi inside this
// repo (package.json → pi.extensions). Both instances would fight over the
// native footer slot and duplicate timers, so only the first load registers.
const GUARD_KEY = "__piStatuslineLiveLoaded";
const FOOTER_ON_KEY = "__piStatuslineLiveFooterOn";
const COLOR_MODE_KEY = "__piStatuslineColorMode";
const CACHE_COLOR_MODE_KEY = "__piStatuslineCacheColors";
const CACHE_GOOD_CODE_KEY = "__piStatuslineCacheGood";

export default function (pi: ExtensionAPI) {
  const g = globalThis as any;
  if (g[GUARD_KEY]) {
    // Already loaded from another source — stay inert (no footer, no timers).
    return;
  }
  // Owner token: cleared on session_shutdown so /reload (which tears down the
  // old runtime before re-importing extensions) can acquire the slot again.
  // Inert duplicates never set the key, so they never clear it.
  const instanceId = `${Date.now()}-${Math.random()}`;
  g[GUARD_KEY] = instanceId;

  let currentCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let spinTimer: ReturnType<typeof setInterval> | undefined;
  let quota: QuotaState = { at: 0, chips: [] };
  let tuiRef: { requestRender(): void } | undefined;
  let footerOn = g[FOOTER_ON_KEY] ?? true;
  function setFooterOn(v: boolean) { footerOn = v; g[FOOTER_ON_KEY] = v; }
  let inFlight = false;
  // live phase
  let phase: Phase = "idle";
  let toolName = "";
  let thinkLevel = "";
  let tick = 0;

  function repaint() {
    try { tuiRef?.requestRender(); } catch { /* ignore */ }
  }
  function setPhase(p: Phase, tool = "") {
    phase = p;
    if (p === "tool") toolName = tool;
    if (p === "idle") toolName = "";
    repaint();
  }
  function syncThinkLevel(ctx: ExtensionContext) {
    try {
      const lvl = (ctx as any).thinkingLevel ?? (pi as any).getThinkingLevel?.();
      if (typeof lvl === "string") thinkLevel = lvl;
    } catch { /* ignore */ }
  }

  function installFooter(ctx: ExtensionContext) {
    currentCtx = ctx;
    syncThinkLevel(ctx);
    ctx.ui.setFooter((tui: any, _theme: any, footerData: any) => {
      tuiRef = tui as unknown as { requestRender(): void };
      const unsub = footerData?.onBranchChange?.(() => repaint());
      return {
        dispose: () => { try { (unsub as any)?.(); } catch { /* ignore */ } },
        invalidate() {},
        render(width: number): string[] {
          syncThinkLevel(ctx);
          return [renderLine(ctx, width, quota, phase, toolName, thinkLevel, tick)];
        },
      };
    });
  }
  function removeFooter(ctx?: ExtensionContext) {
    try { (ctx ?? currentCtx)?.ui.setFooter(undefined); } catch { /* ignore */ }
    tuiRef = undefined;
  }

  async function update(force = false) {
    if (!currentCtx || !footerOn || inFlight) return;
    inFlight = true;
    try {
      quota = await refreshQuotas(currentCtx, force);
      repaint();
    } finally { inFlight = false; }
  }

  function startTimers() {
    if (!timer) {
      timer = setInterval(() => void update(false), REFRESH_MS);
      (timer as any)?.unref?.();
    }
    if (!spinTimer) {
      spinTimer = setInterval(() => {
        if (phase !== "idle") { tick++; repaint(); }
      }, SPIN_MS);
      (spinTimer as any)?.unref?.();
    }
  }
  function stopTimers() {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (spinTimer) clearInterval(spinTimer);
    spinTimer = undefined;
  }

  pi.on("session_start", async (_e, ctx) => {
    if (!footerOn) { currentCtx = ctx; return; }
    installFooter(ctx);
    startTimers();
    void update(true);
  });

  // ── phase tracking ──
  pi.on("agent_start", async (_e, _ctx) => setPhase("run"));
  pi.on("turn_start", async (_e, _ctx) => { if (phase === "idle") setPhase("run"); });
  pi.on("message_update", async (e: any, _ctx) => {
    const t = e?.assistantMessageEvent?.type;
    if (t === "thinking_start" || t === "thinking_delta") { if (phase !== "tool") setPhase("think"); }
    else if (t === "thinking_end") { if (phase === "think") setPhase("run"); }
    else if (t === "text_start" || t === "text_delta") { if (phase === "idle" || phase === "think") setPhase("run"); }
  });
  pi.on("tool_execution_start", async (e: any, _ctx) => setPhase("tool", String(e?.toolName ?? "")));
  pi.on("tool_execution_end", async (_e, _ctx) => { if (phase === "tool") setPhase("run"); });
  pi.on("thinking_level_select", async (e: any, ctx) => {
    if (typeof e?.level === "string") thinkLevel = e.level;
    else syncThinkLevel(ctx);
    repaint();
  });
  pi.on("agent_settled", async (_e, _ctx) => setPhase("idle"));

  pi.on("turn_end", async (_e, ctx) => {
    currentCtx = ctx;
    void update(false);
  });

  pi.on("model_select", async (_e, ctx) => {
    currentCtx = ctx;
    syncThinkLevel(ctx);
    void update(true);
  });

  pi.on("session_shutdown", async () => {
    stopTimers();
    setPhase("idle");
    currentCtx = undefined;
    // Release singleton so the reloaded extension can take over the footer.
    // Only the owner clears — inert duplicates have no shutdown handler.
    try { if (g[GUARD_KEY] === instanceId) delete g[GUARD_KEY]; } catch { /* ignore */ }
  });

  pi.registerCommand("legend", {
    description: "푸터의 ↑ ↓ R·89% W 숫자가 각각 무엇을 세는지 설명한다",
    handler: async (_args, ctx) => {
      const t = ctx.ui.theme;
      ctx.ui.notify(
        [
          "↑ 32.2M  캐시에 없는 입력을 맨돈으로 낸 토큰(비쌈 아님·cold 의 증거)",
          "↓ 671k    모델이生成的한 출력 토큰",
          "R 255.8M  앞부분을 재사용한(cacheRead) — 클수록 좋다",
          "·89%      R/(R+W+↑) 히트율. 색: 85%↑ 초록 · 60%↑ 노랑 · 아래 빨강",
          "(W↑)      이번 세션이 쓴(cacheWrite) 것이 읽은 것보다 많다 = 앞부분이 갈렸다",
          "W 20.2k   이번 턴에 새로 캐시에 쓴 토큰(1.25×, long TTL 은 2×)",
          "$0.42     세션 누적 비용 · 24% [▓▓░░] 236k/1M = 컨텍스트 창 사용량",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("live-status", {
    description: "Toggle / refresh live footer · color <truecolor|256|16|none> · cache [literal|theme|good <cyan|green|blue>]",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      if (a === "off") {
        setFooterOn(false);
        removeFooter(ctx);
        stopTimers();
        ctx.ui.notify("live-statusline off (native footer restored)", "info");
        return;
      }
      if (a === "on") {
        setFooterOn(true);
        installFooter(ctx);
        startTimers();
        void update(true);
        ctx.ui.notify("live-statusline on — refreshing quotas…", "info");
        return;
      }
      if (a === "refresh" || a === "r") {
        currentCtx = ctx;
        await update(true);
        const q = quota.chips.map((c) => {
          const used = Math.max(0, Math.min(100, Math.round(100 - c.remainPct)));
          return `${c.label} ${used}% (⏳ ${fmtReset(c.resetsAt)})`;
        }).join(", ") || quota.error || "no data";
        ctx.ui.notify(`quotas [${quota.provider ?? "?"}]: ${q}`, "info");
        return;
      }
      if (a.startsWith("color")) {
          const m = (a.split(/\s+/)[1] ?? "").trim();
          if (m === "auto" || m === "") delete (globalThis as any)[COLOR_MODE_KEY];
          else if (["truecolor", "256", "16", "none"].includes(m)) (globalThis as any)[COLOR_MODE_KEY] = m;
          else { ctx.ui.notify(`모르는 모드: ${m} — truecolor | 256 | 16 | none | auto`, "error"); return; }
          void update(true);
          ctx.ui.notify(`색 모드 → ${resolveColorMode()} · 안 보이면 16, 그래도 안 보이면 none(색 없이 판정만)`, "info");
          return;
        }

      if (a.startsWith("cache")) {
        const ps = a.split(/\s+/);
        const m = (ps[1] ?? "").trim();
        if (m === "good") {
          const w = (ps[2] ?? "").trim().toLowerCase();
          const code = GOOD_OPTIONS[w];
          if (code == null) {
            ctx.ui.notify(`선택지: ${Object.keys(GOOD_OPTIONS).join(" | ")} — 지금 '정상' 코드는 ${(globalThis as any)[CACHE_GOOD_CODE_KEY] ?? 36}(기본 시안)`, "error");
            return;
          }
          (globalThis as any)[CACHE_GOOD_CODE_KEY] = code;
          void update(true);
          ctx.ui.notify(`캐시 '정상' 색 → SGR ${code} (${w}) · 이 터미널에서 32(초록)가 khaki 로 보이면 36(시안)/94(밝은 파랑)를 써라`, "info");
          return;
        }
        if (m === "theme" || m === "literal") (globalThis as any)[CACHE_COLOR_MODE_KEY] = m;
        else if (m === "" || m === "auto") delete (globalThis as any)[CACHE_COLOR_MODE_KEY];
        else {
          ctx.ui.notify(`캐시 색: /live-status cache [literal|theme|auto] · good <${Object.keys(GOOD_OPTIONS).join("|")}>`, "error");
          return;
        }
        void update(true);
        ctx.ui.notify(`캐시 판정 색 → ${m || "literal(기본)"} · literal 은 SGR 36/33/31 을 bold(주제 무관), theme 은 success/warning/error 를 탄다`, "info");
        return;
      }

      ctx.ui.notify(`live-statusline ${footerOn ? "on" : "off"} · 색 ${resolveColorMode()} · 캐시 ${((globalThis as any)[CACHE_COLOR_MODE_KEY] ?? "literal")}/good ${((globalThis as any)[CACHE_GOOD_CODE_KEY] ?? 36)} — /live-status [on|off|refresh|color <m>|cache [literal|theme|good <c>]]`, "info");
    },
  });
}
