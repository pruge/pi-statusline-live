/**
 * Which Cline token should the statusline use?
 *
 * Pure on purpose — the choice is the cross-package contract with
 * pi-cline-bridge, so it deserves a regression test that does not touch the
 * filesystem.
 *
 * The Cline access token stored on disk is usually already stale: Cline's OAuth
 * rotates the refresh token, so the cached JWT stops being accepted the moment
 * anything refreshes it. Refreshing from the statusline would fix our read but
 * rotate the token out from under pi-cline-bridge and the `cline` CLI, which
 * then fail their next request with 401 (measured). So pi-cline-bridge
 * publishes the key it already resolved to ~/.cline/data/bridge-token.json and
 * we read that instead. Nobody but the active client refreshes.
 */
export interface ClineTokenInputs {
	/** pi-cline-bridge's published key, if it has run this session. */
	published?: { key?: string };
	/** Creds read from ~/.cline/data/settings/providers.json. */
	stored?: { access?: string; expires?: number };
	/** Static API key for usage-billing (no subscription → no gauges). */
	envApiKey?: string;
	/** Treat a stored token as dead inside this window of its expiry. */
	freshWindowMs?: number;
}

/**
 * Preferential order:
 *  1. the bridge's published key — the only one known good right now
 *  2. a stored token that is still comfortably fresh (bridge/CLI not running yet)
 *  3. the static API key
 */
export function pickClineToken(input: ClineTokenInputs, now = Date.now()): string | undefined {
	const freshWindow = input.freshWindowMs ?? 60_000;
	if (typeof input.published?.key === "string" && input.published.key) return input.published.key;
	const stored = input.stored ?? {};
	if (stored.access && (!stored.expires || stored.expires > now + freshWindow)) return stored.access;
	if (input.envApiKey) return input.envApiKey;
	return undefined;
}
