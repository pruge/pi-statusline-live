/**
 * Which Cline token should the statusline use?
 *
 * Pure on purpose — the choice is the cross-package contract with
 * pi-cline-bridge and pi-clinepass-provider, so it deserves a regression test
 * that does not touch the filesystem.
 *
 * The Cline access token stored on disk is usually already stale: Cline's OAuth
 * rotates the refresh token, so the cached JWT stops being accepted the moment
 * anything refreshes it. Refreshing from the statusline would fix our read but
 * rotate the token out from under the client that owns it, which then fails its
 * next request with 401 (measured). So the active client publishes the key it
 * already resolved and we read that instead. Nobody but the active client
 * refreshes.
 *
 * Two clients can own that key, and each publishes somewhere else:
 *
 *   · pi-cline-bridge  → ~/.cline/data/bridge-token.json  (mtime = publish time)
 *   · pi-clinepass-provider → ~/.pi/agent/auth.json `clinepass` (pi refreshes it
 *     through the provider's own `refreshToken`, then rewrites this file)
 *
 * Preference order alone is not enough to pick between them: whichever client
 * is *not* running leaves a token that has since been rotated away. Measured
 * (2026-10-28): the published bridge key was 83 minutes old and answered
 * HTTP 401, while pi's `clinepass` credential had 44 minutes left and answered
 * HTTP 200 with the real 5h/7d/30d windows. So `clineTokenCandidates` only
 * orders the tries and `probeTokens` lets the server decide — first token that
 * answers wins.
 */
export interface ClineTokenInputs {
	/** pi-cline-bridge's published key, if it has run this session. */
	published?: { key?: string };
	/** pi auth (`~/.pi/agent/auth.json`) `clinepass` credential. */
	piAuth?: { access?: string; expires?: number };
	/** Creds read from ~/.cline/data/settings/providers.json. */
	stored?: { access?: string; expires?: number };
	/** Static API key for usage-billing (no subscription → no gauges). */
	envApiKey?: string;
	/** Treat a token as dead inside this window of its expiry. */
	freshWindowMs?: number;
}

function pushToken(out: string[], value: unknown): void {
	if (typeof value !== "string" || !value.trim()) return;
	if (out.includes(value)) return; // 같은 토큰을 두 번 조회하지 않는다
	out.push(value);
}

/**
 * Candidates in try order:
 *  1. the bridge's published key — known good while pi-cline-bridge is running
 *  2. pi's `clinepass` credential — known good while pi-clinepass-provider is
 *     the active client (pi refreshes it and rewrites auth.json)
 *  3. a stored token that is still comfortably fresh (neither client ran yet)
 *  4. the static API key
 *
 * Expiry only filters candidates that carry one; the bridge's file does not, so
 * it is always tried first and a 401 falls through to the next candidate.
 */
export function clineTokenCandidates(input: ClineTokenInputs, now = Date.now()): string[] {
	const freshWindow = input.freshWindowMs ?? 60_000;
	const out: string[] = [];
	pushToken(out, input.published?.key);
	const piAuth = input.piAuth ?? {};
	if (piAuth.access && (!piAuth.expires || piAuth.expires > now + freshWindow)) pushToken(out, piAuth.access);
	const stored = input.stored ?? {};
	if (stored.access && (!stored.expires || stored.expires > now + freshWindow)) pushToken(out, stored.access);
	pushToken(out, input.envApiKey);
	return out;
}

/** The most preferred candidate — kept for callers/tests that only want one. */
export function pickClineToken(input: ClineTokenInputs, now = Date.now()): string | undefined {
	return clineTokenCandidates(input, now)[0];
}

/** Result of asking the server which candidate is real. */
export interface TokenProbe<T> {
	/** Candidate that produced the returned `value` (answered, possibly empty). */
	token?: string;
	value: T[];
	/** At least one candidate got a response — an empty list is then an answer
	 *  ("no subscription windows"), not a credentials failure. */
	answered: boolean;
	/** Candidates rejected by the server (401/403/timeout/network). */
	rejected: number;
}

/**
 * Try each candidate until one answers with a non-empty result; remember the
 * first empty-but-successful answer in case none is non-empty.
 *
 * `attempt` throws when the server rejects the token (or the request fails) and
 * resolves with the parsed windows otherwise. Nothing here interprets the
 * payload — that stays in `quota-windows.ts`.
 */
export async function probeTokens<T>(
	tokens: string[],
	attempt: (token: string) => Promise<T[]>,
): Promise<TokenProbe<T>> {
	let answered = false;
	let rejected = 0;
	let answeredToken: string | undefined;
	let answeredValue: T[] = [];
	for (const token of tokens) {
		let value: T[];
		try {
			value = await attempt(token);
		} catch {
			rejected += 1;
			continue;
		}
		answered = true;
		if (value.length) return { token, value, answered, rejected };
		if (answeredToken === undefined) {
			answeredToken = token;
			answeredValue = value;
		}
	}
	return { token: answeredToken, value: answeredValue, answered, rejected };
}
