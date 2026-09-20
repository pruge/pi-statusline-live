/**
 * pi-statusline-live
 *
 * Mix of:
 *  - @wierdbytes/pi-statusline (base UI: model / path / git / context / cost / tokens)
 *  - @latentminds/pi-quotas (realtime quota fetch: Anthropic 5h/7d, Codex 5h/7d, OpenCode Go 5h/7d/monthly)
 *
 * 0.2.23: Cline 게이지를 pi-cline-bridge 에 연결. 핵심은 토큰이다 — Cline 의 OAuth
 *   refresh token 은 회전해서 디스크의 저장 토큰은 이미 무효인 경우가 대부분이고,
 *   statusline 이 직접 갱신하면 그 토큰을 쓰고 있는 pi-cline-bridge 와 `cline` CLI 의
 *   다음 요청이 401 로 실패한다. 그래서 **bridge 가 갱신해 둔 키를 읽기만 한다**
 *   (~/.cline/data/bridge-token.json). 어느 쪽도 갱신을 두 번 하지 않는다.
 *   pi-clinepass-provider 전용 토큰 소스(~/.pi/agent/auth.json, modelRegistry)는
 *   제거했다 — bridge 가 그 자리를 대신한다.
 *
 * 0.2.22: ClinePass(pi-clinepass-provider) 구독 5h/7d/30d 게이지 — api.cline.bot 의
 *   /api/v1/users/me/plan/usage-limits 를 그대로 쓴다(서버가 percentUsed + resetsAt 를
 *   계산해서 줌). 처음에 plan 한도 + usages 거래를 클라에서 합성했으나 비구독 사용량까지
 *   끌어와 홈페이지와 안 맞았다(18% vs 0%) — 단일 엔드포인트가 정답.
 *   **토큰은 읽기만** — refresh token 이 회전하므로 statusline 이 갱신하면 그 토큰을
 *   쓰는 다른 프로세스의 다음 갱신이 실패한다. 0.2.23 에서 이 읽기 전용 규칙은
 *   bridge 가 발행한 키를 읹는 것으로 지켜진다.
 * 0.2.21: 컨텍스트 캡 어휘를 max/slim 으로 — /ctx max = **그 세션만** Codex
 *   실창(1.05M), /ctx slim = 현행과 같은 272k 자동 compact(기본). 창을 바꾸는 건
 *   pi 의 compact 판정이 `contextWindow - reserveTokens` 하나로 돌기 때문.
 *   max 스위치는 세션 custom entry 에만 남아 resume 해도 그 세션만 풀리고 옆
 *   세션은 slim 그대로. 푸터 ctx 게이지 앞에 모드 칩(🔒slim dim · 🔓max warning)
 *   — 명령을 치면 다음 모델 응답을 기다리지 않고 바로 다시 그려진다.
 * 0.2.18: OpenCode Go 월간(monthly) 게이지 추가 — 5h/7d 옆에 30d 로 붙는다.
 * 0.2.16: OpenCode Go 5h/7d 를 API 키로 조회(https://opencode.ai/zen/go/v1/usage).
 * 대시보드 스크랩(workspaceId + authCookie)은 폴백으로 유지 — 별도 설정 없이 pi auth 의
 * opencode-go/opencode 키(OPENCODE_API_KEY)만으로 게이지가 뜬다.
 * 0.2.14: 두 줄 footer — 1줄 식별(모델·경로·git), 2줄 수치(컨텍스트·비용·토큰·캐시)
 * 0.2.0: the line moved into the native footer slot via ctx.ui.setFooter()
 * (replaces pi's built-in `cwd │ tokens` footer). Above-editor widget removed.
 * A live phase chip leads the line: idle / think / run / tool.
 *
 * Realtime: footer repaints on phase events + quota refresh (60s + turn_end /
 * model_select / session_start). No dependency on either package — standalone.
 */

import { cacheRatio, cacheReadLabel, cacheReadSuffix, cacheTone, cachePaint, colorForTone, GOOD_OPTIONS } from "../src/cache-segment.ts";
import { pickClineToken } from "../src/cline-token.ts";
import { clineWindows, codexWindows, minimaxWindows, opencodeWindows, toMs } from "../src/quota-windows.ts";
import { CTX_TTL_MS, snapshotKey, staleNames, type CtxEntry } from "../src/ctx-snapshot.ts";
import { CTX_CAP_FILE, CTX_CAP_ENTRY, capChipLabel, describeConfig, fmt, parseCapToken, parseConfig, releasedFromEntries, resolveWindow, type CtxCapConfig } from "../src/ctx-cap.ts";
import { detectColorMode, downgradeAnsi, foldLines, paintLiteral } from "../src/ansi.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

// ── gauge colors ──
// context → fullness signal: green (roomy) → yellow (>=60%) → red (>=90%),
// so a low % never reads as danger. 5h/7d → Claude Code usage light blue
// #6da7ec. % number shares its bar color.
const GAUGE_CRIT = 90;
const GAUGE_WARN = 60;
type GaugeColor = "borderAccent" | "warning" | "success" | "error";
function gaugeColor(label: string, used: number): GaugeColor {
  if (used >= GAUGE_CRIT) return "error";
  if (label === "5h" || label === "30d") return "warning";
  if (label === "7d") return "success";
  // context + fallback: fullness signal (green → yellow → red at GAUGE_CRIT).
  return used >= GAUGE_WARN ? "warning" : "success";
}
// Claude Code's usage/limit light blue #6da7ec, emitted raw so downgradeAnsi()
// can step it down for 256/16-color terminals.
const TC_SKY = "38;2;109;167;236";
// 창 게이지(5h/7d/30d)는 한 정체성 색을 공유한다 — 색이 종류를 말하고, 숫자가 한도를 말한다.
const SKY_LABELS = new Set(["5h", "7d", "30d"]);
function paintTC(seq: string, text: string, bold = false): string {
  return `\u001b[${bold ? "1;" : ""}${seq}m${text}\u001b[0m`;
}
// Truecolor sequence for a gauge, or null to use the theme color from
// gaugeColor (context fullness signal, and the >= 90% red).
function gaugeTC(label: string, used: number): string | null {
  if (used >= GAUGE_CRIT) return null;
  if (SKY_LABELS.has(label)) return TC_SKY;
  return null; // context uses the theme fullness color
}
// The colored "NN%" number for a gauge.
function gaugePct(t: any, label: string, used: number): string {
  const seq = gaugeTC(label, used);
  return seq ? paintTC(seq, `${used}%`, true) : t.bold(t.fg(gaugeColor(label, used), `${used}%`));
}
function gaugeBar(t: any, label: string, usedPct: number): string {
  const used = Math.max(0, Math.min(100, Math.round(usedPct)));
  const filled = Math.floor((used * 10) / 100);
  const seq = gaugeTC(label, used);
  const on = seq
    ? paintTC(seq, "▓".repeat(filled), true)
    : t.bold(t.fg(gaugeColor(label, used), "▓".repeat(filled)));
  return on + t.fg("dim", "░".repeat(10 - filled));
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
    "claude-bridge": "Claude",
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
    clinepass: "ClinePass",
    cline: "Cline",
    "cline-bridge": "Cline",
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
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
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
  let cost = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, turns = 0;
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if ((e as any).type === "message" && (e as any).message?.role === "assistant") {
        const u = (e as any).message.usage;
        if (!u) continue;
        turns++;
        cost += u.cost?.total ?? 0;
        input += u.input ?? 0;
        output += u.output ?? 0;
        cacheRead += u.cacheRead ?? 0;
        cacheWrite += u.cacheWrite ?? 0;
      }
    }
  } catch { /* session not ready */ }
  return { cost, input, output, cacheRead, cacheWrite, turns };
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

// pi-claude-bridge (Claude Code SDK, Pro/Max 구독) 의 OAuth 토큰. 5h/7d(weekly) 는 Claude 구독
// 한도라 anthropic 과 같은 oauth/usage 엔드포인트가 답한다 — 토큰만 찾으면 fetchAnthropic 를 재사용한다.
// 출처 순서(모두 실패하면 undefined → 게이지 없이 ⚡Claude 칩만): 셋 다 자동, 하나라도 되면 auto-fill.
//   1) 환경변수 CLAUDE_CODE_OAUTH_TOKEN (명시 override — 확장/CI 용)
//   2) ~/.claude/.credentials.json 의 claudeAiOauth.accessToken (파일 기반 = Linux)
//   3) macOS Keychain "Claude Code-credentials" 의 claudeAiOauth.accessToken
function claudeBridgeToken(): string | undefined {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) return env;
  const file = readJson(join(homedir(), ".claude", ".credentials.json"));
  const fromFile = file?.claudeAiOauth?.accessToken;
  if (typeof fromFile === "string" && fromFile) return fromFile;
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      if (typeof tok === "string" && tok) return tok;
    } catch { /* keychain 없음·접근 거부·미로그인 → 게이지 없이 진행(확장점: 위 env 로 주입) */ }
  }
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
async function opencodeGoApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const r: any = ctx.modelRegistry as any;
    const t = await r?.authStorage?.getApiKey?.("opencode-go")
      ?? await r?.authStorage?.getApiKey?.("opencode")
      ?? await r?.getApiKeyForProvider?.("opencode-go")
      ?? await r?.getApiKeyForProvider?.("opencode");
    if (typeof t === "string" && t) return expandCommandRef(t);
  } catch { /* fall through */ }
  if (process.env.OPENCODE_API_KEY?.trim()) return process.env.OPENCODE_API_KEY.trim();
  const auth = readJson(join(homedir(), ".pi", "agent", "auth.json"));
  for (const k of ["opencode-go", "opencode"]) {
    const v = auth?.[k]?.key ?? auth?.[k]?.access;
    if (typeof v === "string" && v) {
      const expanded = expandCommandRef(v);
      if (expanded) return expanded;
    }
  }
  return undefined;
}
// pi auth 의 `!command` 참조(예: `!security find-generic-password -ws 'opencode'`)를 실행해 푼다.
function expandCommandRef(ref: string): string | undefined {
  if (!ref.startsWith("!")) return ref.trim() || undefined;
  try {
    const out = execFileSync("sh", ["-c", ref.slice(1)], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch { return undefined; }
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

// Cline 구독 사용량 — https://api.cline.bot. pi-cline-bridge 와 `cline` CLI 는
// ~/.cline/data/settings/providers.json(providers["cline-pass"|"cline"].settings.auth)
// 에 저장된 OAuth 토큰을 공유한다. **우리는 그 토큰을 읽기만 한다** — Cline 의 refresh
// token 은 회전하기 때문에 statusline 이 갱신을 직접 시도하면 토큰을 쓰는 다른 프로세스의
// 다음 요청이 401 로 실패한다(실측). 만료 임박 토큰은 건너뛰고, 다음 completion 이
// 갱신시킬 때까지 기다린다(≤60s tick 이 다시 집는다).
const CLINE_API_BASE = process.env.CLINE_API_BASE?.trim() || "https://api.cline.bot";
function clineStoredCredentials(): { access?: string; expires?: number } {
  const pick = (o: any): { access?: string; expires?: number } | undefined => {
    const access = o?.access ?? o?.key ?? o?.apiKey;
    if (typeof access !== "string" || !access) return undefined;
    return { access, expires: Number(o?.expires) || undefined };
  };
  const cli = readJson(join(homedir(), ".cline", "data", "settings", "providers.json"));
  const providers = cli?.providers;
  for (const k of ["cline-pass", "cline"]) {
    const settings = providers?.[k]?.settings;
    const got = pick(settings?.auth) ?? pick(settings);
    if (got) return got;
  }
  return {};
}
async function clineToken(): Promise<string | undefined> {
  // pi-cline-bridge 가 갱신해 둔 키 — 유일하게 '지금 유효한' 키다. Cline 의 저장된
  //  토큰은 회전을 통해 이미 무효가 된 경우가 많고, statusline 이 직접 갱신하면
  //  토큰을 쓰는 다른 프로세스(bridge/CLI)의 다음 요청이 401 로 실패한다.
  return pickClineToken({
    published: readJson(join(homedir(), ".cline", "data", "bridge-token.json")),
    stored: clineStoredCredentials(),
    envApiKey: process.env.CLINE_API_KEY?.trim(),
  });
}
// Cline usage — 서버가 사용률을 직접 계산하는 단일 엔드포인트. 클라이언트가
// plan(한도)+usages(거래) 를 합성하면 비구독 사용량까지 끌어오므로 쓰지 않는다(실측).
// 응답 해석은 src/quota-windows.ts 의 clineWindows 한 곳에서만.
async function fetchCline(token?: string): Promise<QuotaChip[]> {
  if (!token || token.startsWith("!")) return [];
  const d: any = await fetchJson(`${CLINE_API_BASE}/api/v1/users/me/plan/usage-limits`,
    { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "Cline/4.1.10" });
  return clineWindows(d);
}

// ── fetch ──
async function fetchJson(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const combined = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  const res = await fetch(url, { headers, signal: combined });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  return codexWindows(d);
}
// OpenCode Go 5h/7d/30d — 1순위: API 키(推論와 같은 키)로 https://opencode.ai/zen/go/v1/usage 조회.
// 응답: { usage: { rolling: { percent(사용량), resetsAt }, weekly: {...}, monthly: {...} } }.
// 필드 해석은 src/quota-windows.ts 의 opencodeWindows 한 곳에서만 한다.
// 2순위: 대시보드 스크랩(workspaceId + authCookie) — API 접근이 안 되는 키용 폴백.
async function fetchOpenCodeGoApi(apiKey?: string): Promise<QuotaChip[]> {
  if (!apiKey || apiKey.startsWith("!")) return [];
  let d: any;
  try {
    d = await fetchJson("https://opencode.ai/zen/go/v1/usage",
      { Authorization: `Bearer ${apiKey}`, Accept: "application/json" });
  } catch { return []; }
  return opencodeWindows(d);
}
async function fetchOpenCodeGo(ctx?: ExtensionContext): Promise<QuotaChip[]> {
  try {
    const apiKey = ctx ? await opencodeGoApiKey(ctx) : process.env.OPENCODE_API_KEY?.trim() || undefined;
    const viaApi = await fetchOpenCodeGoApi(apiKey);
    if (viaApi.length) return viaApi;
  } catch { /* fall through to scrape */ }
  const cfg = opencodeGoConfig();
  if (!cfg) return [];
  const url = `https://opencode.ai/workspace/${encodeURIComponent(cfg.workspaceId)}/go`;
  const combined = AbortSignal.any([AbortSignal.timeout(10000)]);
  const cookie = cfg.authCookie.includes("=") ? cfg.authCookie : `auth=${cfg.authCookie}`;
  const res = await fetch(url, { headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" }, signal: combined });
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
  const mo = grab("monthlyUsage");
  if (mo) out.push({ label: "30d", remainPct: Math.max(0, 100 - mo.pct), resetsAt: Date.now() + Math.max(0, mo.resetSec) * 1000 });
  return out;
}
// MiniMax Token Plan 5h/7d — `mmx quota show --output json --quiet --non-interactive` 를
// 그대로 실행한다. CLI 가 Akamai/쿠키/세션 갱신을 다 처리하므로 statusline 은 응답만 해석한다.
// 쿠키를 절대 만지지 않는다 — MiniMax OAuth 토큰은 회전하므로 statusline 이 직접 갱신하면
// 그 토큰을 쓰는 다음 CLI 호출이 401 로 실패한다(다른 provider 와 같은 규율).
// mmx 미설치/로그아웃/네트워크 오류 → 빈 배열(게이지 없음, 에러 상태로 표시).
async function fetchMiniMax(): Promise<QuotaChip[]> {
  let raw: string;
  try {
    raw = execFileSync("mmx", ["quota", "show", "--output", "json", "--quiet", "--non-interactive"],
      { timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return []; // ENOENT / non-zero exit / timeout — 그이지 없음
  }
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return []; }
  if (payload?.base_resp?.status_code !== 0) return [];
  return minimaxWindows(payload);
}

// ── ctx snapshot: 중앙 레지스트리 ~/.pi/agent/ctx-sessions/<pane|session|pid>.json ──
// orch(tf_status·idle 워치)가 읽는다. 쓰기: turn_end·model_select·60s tick. prune: 쓸 때마다
// TTL(30분) 밖 정리, 끝날 때 자기 파일 삭제. tmp+rename 원자 쓰기, 전부 best-effort(푸터를 못 깨운다).
function writeCtxSnapshot(ctx: ExtensionContext) {
  try {
    let win = 0, cur = 0;
    try {
      const u = ctx.getContextUsage();
      win = u?.contextWindow ?? (ctx as any)?.model?.contextWindow ?? 0;
      cur = u?.tokens ?? 0;
    } catch { return; }
    if (!(win > 0)) return;
    const dir = join(homedir(), ".pi", "agent", "ctx-sessions");
    mkdirSync(dir, { recursive: true });
    const entry: CtxEntry = {
      v: 1,
      pane: process.env.HERDR_PANE_ID || undefined,
      session: process.env.PI_SESSION_ID || undefined,
      cwd: (() => { try { return ctx.cwd; } catch { return process.cwd(); } })(),
      model: (() => { try { return shortenModel((ctx as any)?.model); } catch { return undefined; } })(),
      provider: (() => { try { const p = (ctx as any)?.model?.provider; return typeof p === "string" ? p : undefined; } catch { return undefined; } })(),
      pct: Math.floor((cur * 100) / win), cur, win, at: new Date().toISOString(),
    };
    const file = join(dir, `${snapshotKey()}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
    try {
      const withAt = readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))
        .map((f) => {
          try { return { name: f, at: (JSON.parse(readFileSync(join(dir, f), "utf8")) as any)?.at }; }
          catch { return { name: f, at: undefined }; }
        });
      for (const n of staleNames(withAt, Date.now(), CTX_TTL_MS)) {
        try { rmSync(join(dir, n), { force: true }); } catch { /* 다음 기회에 */ }
      }
    } catch { /* prune 실패는 다음 기회에 */ }
  } catch { /* 스냅샷은 푸터를 절대 깨지 않는다 */ }
}
function removeCtxSnapshot() {
  try { rmSync(join(homedir(), ".pi", "agent", "ctx-sessions", `${snapshotKey()}.json`), { force: true }); } catch { /* ignore */ }
}

// ── ctx cap: ~/.pi/agent/ctx-window.json (전역 기본값) + 세션 custom entry(해제) ──
// pi 의 자동 compact 판정은 `contextTokens > model.contextWindow - reserveTokens` 라서
// **모델 창 하나**가 compact 지점을 정한다(전역 reserveTokens 를 키우면 다른 모델까지
// 매 턴 compact 되고 요약 출력 상한이 128k 로 폭주한다 — 그래서 창을 만진다).
//
// 층이 둘이다:
//   전역 파일  = 캡 수치·대상 provider (모든 세션이 공유)
//   세션 entry = "이 세션은 해제" — pi.appendEntry("ctx-cap") 로 그 세션 파일에만 남는다
// 그래서 한 세션에서 /ctx off 를 쳐도 다른 세션은 272k 캡 그대로다.
// 규칙·파싱은 src/ctx-cap.ts(순수), IO 는 여기만.
function ctxCapPath(): string { return join(homedir(), ".pi", "agent", CTX_CAP_FILE); }
function loadCtxCap(): CtxCapConfig {
  try { return parseConfig(JSON.parse(readFileSync(ctxCapPath(), "utf8"))); } catch { return parseConfig(undefined); }
}
function saveCtxCap(cfg: CtxCapConfig): void {
  try {
    const file = ctxCapPath();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    renameSync(tmp, file);
  } catch { /* 설정 저장 실패는 푸터를 깨지 않는다 */ }
}

// per-provider cache (anthropic 5min, others 60s)
const quotaCache = new Map<string, QuotaState>();
const TTL: Record<string, number> = { anthropic: 5 * 60_000, "claude-bridge": 5 * 60_000, "openai-codex": 60_000, "opencode-go": 60_000, "cline-bridge": 60_000, clinepass: 60_000, cline: 60_000, minimax: 60_000, "minimax-cn": 60_000 };

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
    } else if (provider === "claude-bridge") {
      // pi-claude-bridge = Claude 구독. 5h/7d 는 anthropic 과 동일 엔드포인트 — 토큰만 다른 출처.
      state.chips = await fetchAnthropic(claudeBridgeToken());
      if (state.chips.length === 0) state.error = "no-oauth";
    } else if (provider === "openai-codex") {
      const { token, accountId } = await codexCreds(ctx);
      state.chips = await fetchCodex(token, accountId);
      // 자격증명이 있는데 창이 비면 이유는 파싱이다 — 'no-creds' 로 묶으면 진단이 한 단계 멈춘다.
      if (state.chips.length === 0) state.error = token && accountId ? "no-usage" : "no-creds";
    } else if (provider === "opencode" || provider === "opencode-go") {
      state.chips = await fetchOpenCodeGo(ctx);
      if (state.chips.length === 0) state.error = "no-go-config";
    } else if (provider === "minimax" || provider === "minimax-cn") {
      state.chips = await fetchMiniMax();
      if (state.chips.length === 0) state.error = "no-mmx";
    } else if (provider === "cline-bridge" || provider === "clinepass" || provider === "cline") {
      // Cline 구독(pi-cline-bridge, 또는 기본 Cline provider): 서버가 사용률을 직접 계산하는
      // 단일 엔드포인트. 토큰이 있어도 구독이 없거나 토큰이 만료됐으면 게이지가 안 뜬다(실패가 아니다).
      const t = await clineToken();
      state.chips = await fetchCline(t);
      if (state.chips.length === 0) state.error = t ? "no-plan" : "no-creds";
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
/** 푸터가 그리는 캡 상태 칩. null = 이 provider 는 캡 대상이 아니다(칩 없음). */
type CapChip = { released: boolean; label: string } | null;
function capChipText(t: any, chip: CapChip): string {
  if (!chip) return "";
  // 해제는 예외 상태다 — 경고색·bold 로 눈에 띄게. 캡(기본)은 dim 으로 조용히.
  const paint = chip.released ? t.bold(t.fg("warning", chip.label)) : t.fg("dim", chip.label);
  return paint + " ";
}
function renderLine(
  ctx: ExtensionContext, width: number, quota: QuotaState,
  phase: Phase, toolName: string, thinkLevel: string, tick: number, capChip: CapChip = null,
): string[] {
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
  // ⚡provider chip stays by the model; the 5h/7d gauges move down next to the context gauge.
  const quotaChips: string[] = quota.chips.map((c) => {
    const used = Math.max(0, Math.min(100, Math.round(100 - c.remainPct)));
    // 5h/7d 라벨은 빼고 리셋까지 시간만 → "2% ░░░░░░░░░░ 4d 2h" (둘 다 Claude 사용량 옆파랑).
    const tail = fmtReset(c.resetsAt);
    return gaugePct(t, c.label, used) + " " + gaugeBar(t, c.label, used) + (tail ? t.fg("dim", ` ${tail}`) : "");
  });
  if (activeProvider) parts.push(t.fg("accent", `⚡${providerLabel(activeProvider)}`));
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
  parts.push(SPLIT_MARK);
  // context (fullness signal: green → yellow → red)
  if (ctxWin > 0 && ctxPct >= 0) {
    // 창 대비 사용량 하나를 두 번 말하지 않는다(백분율 + 게이지 + "남은 토큰") → "24% ▓▓░░ 236k/1M"
    // 앞의 칩이 "지금 1M 인가 272k 인가"를 색과 자물쇠로 말한다 — 명령 직후 바로 바뀐다.
    parts.push(capChipText(t, capChip) + gaugePct(t, "ctx", ctxPct) + " " + gaugeBar(t, "ctx", ctxPct) + t.fg("dim", ` ${fmtTokens(ctxCur)}/`) + t.fg(capChip?.released ? "warning" : "accent", fmtWin(ctxWin)));
  }
  // 5h/7d quota gauges — each its own part so the │ separator sits between them.
  for (const q of quotaChips) parts.push(q);
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
  const rw = cacheReadSuffix(stats);
  // 색 배치(주제 무관 16색, bad 만 bold): 85%↑ 초록 · 60%↑ 노랑+! · 아래 빨강+!!(+W↑)
  // 테마 경유가 필요하면 /live-status cache theme — dark 의 success(#b5bd68) 는 text 와 구별이 안 된다.
  const cacheMode = ((globalThis as any)[CACHE_COLOR_MODE_KEY] ?? "literal") === "theme" ? "theme" : "literal";
  const paint = cachePaint(rTone, cacheMode, cacheMode === "theme" ? colorForTone(t, rTone) : undefined, (globalThis as any)[CACHE_GOOD_CODE_KEY]);
  const seg: string[] = [];
  if (tok.length) seg.push(t.fg("dim", tok.join(" ")));
  // 색은 **비율에만** 입힌다. `R272.2M` 은 크기일 뿐(매 턴 커지는 수)이라 그것까지 칠리면
  // 줄 전체가 시안/노랑/빨강로 시끄러워져 판정이 한 조각에서 읽히지 않는다.
  const rQuiet = cacheReadLabel(stats as { cacheRead?: number; turns?: number });
  if (rw) {
    // 한 조각으로 push 한다: seg 는 " " 로 join 되므로 따로 넣으면 "R272.2M ·89%" 가 된다.
    const hot = paint.kind === "literal" ? paintLiteral(paint.code, rw, paint.bold) : paint.kind === "theme" ? (paint.bold ? t.bold(t.fg(paint.name, rw)) : t.fg(paint.name, rw)) : t.fg("dim", rw);
    seg.push(t.fg("dim", rQuiet) + hot);
  }
  if (stats.cacheWrite > 0) seg.push(t.fg("dim", `W${fmtTokens(stats.cacheWrite)}`));
  if (seg.length) parts.push(seg.join(" "));

  const sep = t.fg("dim", " │ ");
  // 테마가 truecolor 로 내는 색을 터미널/중간 계층(herdr·tmux·구 TERM)이 삼키면
  // 전부 "일반 텍스트 색"으로 뜬다. 그 경우엔 256/16 으로 강등해 보낸다(판정이 색에만 실리면 안 된다).
  // **두 줄**: 첫 줄은 식별(모델·경로·git), 둘째 줄은 수치(컨텍스트·비용·토큰·캐시).
  // 한 줄에 다 실으면 폭이 모자라 뒤가 잘리고, 잘린 숫자는 숫자가 아니다(사용자 요구).
  return foldLines(parts, sep, SPLIT_MARK, width, (x, w) => downgradeAnsi(truncateToWidth(x, w), resolveColorMode()));
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
/** render 안의 줄 위치 표식(문자 조각이 아니라 자리). */
const SPLIT_MARK = "\u0000split\u0000";

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
  let capCfg: CtxCapConfig = loadCtxCap();
  // 이 세션 전용 해제 스위치 — 세션 entry 에서 복원, /ctx off 로만 켜진다.
  let capReleased = false;
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

  // 모델 창을 설정대로 맞춘다. **바뀔 때만** pi.setModel — 캡(기본)에서는 카탈로그
  // 값(272k)과 같아 호출 자체가 없다(세션에 model_change 오염 0). 이 세션만 해제하면
  // 세션당 1회 model_change + 1회 ctx-cap entry 가 남는다.
  function nativeWindow(ctx: ExtensionContext): number {
    try {
      const m = ctx.model;
      if (!m) return 0;
      return ctx.modelRegistry.find(m.provider, m.id)?.contextWindow ?? m.contextWindow;
    } catch { return ctx.model?.contextWindow ?? 0; }
  }
  let applyingCap = false;
  async function applyCap(ctx: ExtensionContext): Promise<void> {
    if (applyingCap) return; // 우리 setModel 이 띄운 model_select 재진입 차단
    try {
      const model = ctx.model;
      if (!model) return;
      const want = resolveWindow(nativeWindow(ctx), model.provider, capCfg, capReleased);
      if (!(want > 0) || model.contextWindow === want) return;
      applyingCap = true;
      await pi.setModel({ ...model, contextWindow: want });
      repaint();
    } catch { /* 캡 적용 실패는 세션을 깨지 않는다 */ }
    finally { applyingCap = false; }
  }
  /** 이 세션에만 해제 상태를 기록한다(전역 파일 아님). */
  function persistReleased(): void {
    try { pi.appendEntry(CTX_CAP_ENTRY, { released: capReleased }); } catch { /* ignore */ }
  }
  function capStatus(ctx: ExtensionContext): string {
    const m = ctx.model;
    const w = typeof m?.contextWindow === "number" ? m.contextWindow : 0;
    const native = nativeWindow(ctx);
    const model = m ? `${m.provider}/${m.id}` : "?";
    const sid = (() => { try { return ctx.sessionManager.getSessionId(); } catch { return "?"; } })();
    return `${describeConfig(capCfg, capReleased)} · ${model} 창 ${w > 0 ? fmt(w) : "?"}${native > 0 && native !== w ? ` (카탈로그 ${fmt(native)})` : ""} · 세션 ${String(sid).slice(0, 8)}`;
  }
  /** 푸터 칩: 이 provider 가 캡 대상일 때만. 명령 직후 render 가 바로 읽는다. */
  function capChipFor(ctx: ExtensionContext): CapChip {
    try {
      const p = ctx.model?.provider;
      if (!p) return null;
      const full = capCfg.providers[p];
      if (!(typeof full === "number" && full > 0)) return null;
      return { released: capReleased, label: capChipLabel(capReleased) };
    } catch { return null; }
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
          return renderLine(ctx, width, quota, phase, toolName, thinkLevel, tick, capChipFor(ctx));
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
      timer = setInterval(() => { void update(false); if (currentCtx) writeCtxSnapshot(currentCtx); }, REFRESH_MS);
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
    currentCtx = ctx;
    // 이 세션 파일에 남은 해제 상태만 복원한다 — 다른 세션은 영향을 받지 않는다.
    try { capReleased = releasedFromEntries(ctx.sessionManager.getEntries()); } catch { capReleased = false; }
    void applyCap(ctx); // 푸터 on/off 와 무관하게 캡은 적용된다
    if (!footerOn) return;
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
    writeCtxSnapshot(ctx);
    void update(false);
  });

  pi.on("model_select", async (_e, ctx) => {
    currentCtx = ctx;
    syncThinkLevel(ctx);
    void applyCap(ctx);
    writeCtxSnapshot(ctx);
    void update(true);
  });

  pi.on("session_shutdown", async () => {
    removeCtxSnapshot();
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

  pi.registerCommand("ctx", {
    description: "컨텍스트 캡 — /ctx max = 이 세션만 1.05M, /ctx slim = 272k 자동 compact(기본)",
    getArgumentCompletions: (prefix: string) => {
      const items = ["status", "max", "slim", "toggle"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const a = (args ?? "").trim().toLowerCase();
      if (a === "" || a === "status") { ctx.ui.notify(capStatus(ctx), "info"); return; }
      // max = 실제 창까지(이 세션) · slim = 캡(이 세션, 기본). 별칭은 그 방향을 따른다.
      if (a === "max" || a === "1m" || a === "on" || a === "unlock" || a === "free") capReleased = true;
      else if (a === "slim" || a === "272k" || a === "off" || a === "lock") capReleased = false;
      else if (a === "toggle") capReleased = !capReleased;
      else if (a.startsWith("slim") || a.startsWith("cap")) {
        // `/ctx slim 300k` = 그 값을 **전역** 기본 캡으로 저장하고 이 세션을 slim 으로.
        const tok = a.split(/\s+/)[1];
        const n = tok ? parseCapToken(tok) : null;
        if (n === null) {
          ctx.ui.notify(`사용: /ctx slim <272k|300k|1m> — 전역 기본 캡(모든 세션). 이 세션만 바꾸려면 /ctx max|slim.`, "error");
          return;
        }
        capCfg = { ...capCfg, cap: n };
        capReleased = false;
        saveCtxCap(capCfg);
      } else {
        ctx.ui.notify(`모르는 인자: ${a} — /ctx [status|max|slim|toggle] · /ctx slim <272k|300k|1m>(전역)`, "error");
        return;
      }
      persistReleased();
      await applyCap(ctx);
      // 명령 직후 바로 반영: 다음 코드덱스 응답을 기다리지 않는다. 스냅샷도 같이(orch 몫).
      try { writeCtxSnapshot(ctx); } catch { /* ignore */ }
      repaint();
      ctx.ui.notify(capStatus(ctx), "info");
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
          const reset = fmtReset(c.resetsAt);
          // Cline 창은 rolling 이라 리셋이 없다 — 빈 괄호를 남기지 않는다.
          return reset ? `${c.label} ${used}% (⏳ ${reset})` : `${c.label} ${used}%`;
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
