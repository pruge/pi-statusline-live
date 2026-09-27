/**
 * The "native" context window — the full window the model would have if no cap
 * were applied — for the 🔒slim / 🔓max chip.
 *
 * Why this file exists: pi's model catalog under-reports. openai-codex ships
 * 272k for every gpt-5.5+ model, while the provider really serves 1.05M. pi-ctx
 * compensates with a provider override (~/.pi/agent/ctx-window.json), so the
 * statusline must apply the same precedence to agree with `/ctx status`:
 *
 *   observed store  >  provider override  >  catalog
 *
 * Reading only the catalog makes `capChip(272000, 272000)` and the footer prints
 * 🔓max while the session is slim — the cap is invisible precisely for the models
 * that have an override.
 *
 * The precedence also mirrors pi-ctx's one early exit: a window already below the
 * global cap is left alone and the override is ignored, so `gpt-5.3-codex-spark`
 * (128k catalog) stays 128k even though openai-codex overrides to 1.05M. Without
 * that, a spark session would read as permanently slim.
 *
 * Read-only by contract (same rule as the Cline bridge token): this module never
 * writes these files and never decides a cap. It only reproduces pi-ctx's
 * definition of the native window so the chip compares like with like.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi-ctx's default when `ctx-window.json` is missing or unusable. */
export const DEFAULT_CAP = 272_000;

/** `provider/model`, the key both stores use. Undefined if not spellable. */
export function nativeWindowKey(provider: string | undefined, model: string | undefined): string | undefined {
	const p = typeof provider === "string" ? provider.trim() : "";
	const m = typeof model === "string" ? model.trim() : "";
	if (!p || !m || p.includes("/")) return undefined;
	return `${p}/${m}`;
}

/**
 * pi-ctx's `resolveWindow(native, provider, cfg, released)` in read-only form: the
 * window the model gets with the cap lifted (`released: true`).
 */
export function resolveNativeWindow(sources: {
	observed?: { contextWindow?: unknown };
	overrides?: Record<string, unknown>;
	catalog?: number;
	cap?: number;
}, key: string | undefined): number {
	const positive = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
	const base = positive(sources.observed?.contextWindow) ?? positive(sources.catalog) ?? 0;
	if (!(base > 0)) return 0;
	// pi-ctx returns the window untouched when it is already below the cap.
	if (base < (positive(sources.cap) ?? DEFAULT_CAP)) return base;
	const provider = key?.slice(0, key.indexOf("/"));
	const override = provider ? positive(sources.overrides?.[provider]) : undefined;
	return override ?? base;
}

function parseJson(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function positive(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** `~/.pi/agent/pi-ctx/windows.json`, overridable so tests never touch ~/.pi. */
export function windowsStorePath(home = homedir()): string {
	const override = process.env.PI_CTX_WINDOWS_PATH;
	if (override && override.trim()) return override;
	return join(home, ".pi", "agent", "pi-ctx", "windows.json");
}

/** `~/.pi/agent/ctx-window.json` — pi-ctx's global cap + provider overrides. */
export function capConfigPath(home = homedir()): string {
	return join(home, ".pi", "agent", "ctx-window.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stamp(path: string): number {
	try { return statSync(path).mtimeMs; } catch { return 0; }
}

// The footer repaints on a timer, so re-reading + re-parsing two JSON files on
// every tick is waste. Key the cache on mtime: a `/ctx slim 300k` or a new
// observation still shows up on the next paint.
const cache = new Map<string, { at: number; observed?: unknown; cap: number; overrides?: Record<string, unknown> }>();

function readStores(home: string): { observed?: unknown; cap: number; overrides?: Record<string, unknown> } {
	const store = windowsStorePath(home);
	const config = capConfigPath(home);
	const at = stamp(store) + stamp(config);
	const hit = cache.get(home);
	if (hit && hit.at === at) return { observed: hit.observed, cap: hit.cap, overrides: hit.overrides };
	const observed = parseJson(store);
	const raw = parseJson(config);
	const overrides = isRecord(raw) && isRecord(raw.providers) ? raw.providers : undefined;
	const cap = isRecord(raw) && positive(raw.cap) ? (positive(raw.cap) as number) : DEFAULT_CAP;
	cache.set(home, { at, observed, cap, overrides });
	return { observed, cap, overrides };
}

function observedEntry(store: unknown, key: string | undefined): unknown {
	if (!isRecord(store) || !key) return undefined;
	const entry = store[key];
	return isRecord(entry) ? entry : undefined;
}

/** Native window for the active model, resolved from the stores on disk. */
export function nativeWindow(
	provider: string | undefined,
	model: string | undefined,
	catalog: number,
	home = homedir(),
): number {
	const key = nativeWindowKey(provider, model);
	const { observed, cap, overrides } = readStores(home);
	return resolveNativeWindow(
		{ observed: observedEntry(observed, key), overrides, catalog: positive(catalog), cap },
		key,
	);
}
