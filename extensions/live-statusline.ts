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

// ── tiny helpers ──
function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}
function shortenPath(cwd: string): string {
  const s = cwd.split("/");
  if (s.length <= 3) return cwd;
  return `…/${s[s.length - 3]}/${s[s.length - 2]}/${s[s.length - 1]}`;
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
  // model
  parts.push(t.fg("accent", `🤖 ${shortenModel(ctx.model)}`));
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
  // context
  if (ctxWin > 0 && ctxPct >= 0) {
    const col = ctxPct > 80 ? "error" : ctxPct > 60 ? "warning" : "success";
    const filled = Math.floor((Math.min(100, ctxPct) * 10) / 100);
    parts.push(t.fg(col, `${ctxPct}%`) + t.fg("dim", `:${fmtTokens(ctxCur)}[${"▓".repeat(filled)}${"░".repeat(10 - filled)}]${fmtTokens(Math.max(0, ctxWin - ctxCur))}`));
  }
  // cost
  if (stats.cost > 0) parts.push(t.fg("dim", `$${stats.cost.toFixed(2)}`));
  // tokens
  const tok: string[] = [];
  if (stats.input > 0) tok.push(`↑${fmtTokens(stats.input)}`);
  if (stats.output > 0) tok.push(`↓${fmtTokens(stats.output)}`);
  if (stats.cacheRead > 0) tok.push(`R${fmtTokens(stats.cacheRead)}`);
  if (stats.cacheWrite > 0) tok.push(`W${fmtTokens(stats.cacheWrite)}`);
  if (tok.length) parts.push(t.fg("dim", tok.join(" ")));

  // ── LIVE quotas, context-style bars (used%[bar]remain%) ──
  if (quota.chips.length > 0) {
    const q = quota.chips.map((c) => {
      const used = Math.max(0, Math.min(100, Math.round(100 - c.remainPct)));
      const remain = Math.max(0, Math.min(100, Math.round(c.remainPct)));
      const col = used > 80 ? "error" : used > 60 ? "warning" : "success"; // same thresholds as context
      const filled = Math.floor((used * 10) / 100);
      const bar = t.fg(col, "▓".repeat(filled)) + t.fg("dim", "░".repeat(10 - filled));
      const reset = c.resetsAt ? t.fg("dim", `↺${fmtReset(c.resetsAt)}`) : "";
      return t.fg("dim", `${c.label} `) + t.fg(col, `${used}%`) + t.fg("dim", "[") + bar + t.fg("dim", "]") + t.fg("dim", `${remain}%`) + reset;
    }).join(t.fg("dim", " "));
    const provTag = quota.provider === "anthropic" ? "An" : quota.provider === "openai-codex" ? "Cx" : "Go";
    parts.push(t.fg("accent", `⚡${provTag} `) + q);
  } else if (quota.provider === "anthropic" || quota.provider === "openai-codex" || quota.provider === "opencode" || quota.provider === "opencode-go") {
    // provider supported but no data yet — subtle placeholder, not noisy
    parts.push(t.fg("dim", "⚡…"));
  }

  const sep = t.fg("dim", " │ ");
  return truncateToWidth(parts.join(sep), width);
}

// ── extension ──
export default function (pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let spinTimer: ReturnType<typeof setInterval> | undefined;
  let quota: QuotaState = { at: 0, chips: [] };
  let tuiRef: { requestRender(): void } | undefined;
  let footerOn = true;
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
  });

  pi.registerCommand("live-status", {
    description: "Toggle / refresh live footer (phase + model/path/git/context + live quotas)",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      if (a === "off") {
        footerOn = false;
        removeFooter(ctx);
        stopTimers();
        ctx.ui.notify("live-statusline off (native footer restored)", "info");
        return;
      }
      if (a === "on") {
        footerOn = true;
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
          return `${c.label} ${used}% (↺${fmtReset(c.resetsAt)})`;
        }).join(", ") || quota.error || "no data";
        ctx.ui.notify(`quotas [${quota.provider ?? "?"}]: ${q}`, "info");
        return;
      }
      ctx.ui.notify(`live-statusline ${footerOn ? "on" : "off"} — usage: /live-status [on|off|refresh]`, "info");
    },
  });
}
