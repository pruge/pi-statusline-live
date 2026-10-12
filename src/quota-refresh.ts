/**
 * Refresh scheduling for the live quota chip.
 *
 * A session replacement lands on the settings-default provider before the
 * session's own model is restored (pi-ctx's `/clear` does exactly this), so
 * `model_select` can fire while a fetch for the provider we just left is still
 * in flight. The footer must never keep a quota — or the ⚡ chip — for a provider
 * the session has left:
 *
 *   · a request that arrives mid-flight is queued, not dropped, so the latest
 *     provider always gets its own fetch;
 *   · a state whose provider no longer matches the live model is not applied,
 *     so the ⚡ chip falls back to the live `ctx.model.provider` instead of lying.
 */

/**
 * A cached quota belongs to `cached`, but the session is now on `live`.
 * Only true when both are known and differ — an unknown live provider is not
 * evidence of a change, so the caller keeps the cached state.
 */
export function providerIsStale(cached: string | undefined, live: string | undefined): boolean {
	const known = (p: string | undefined): p is string => typeof p === "string" && p !== "";
	return known(cached) && known(live) && cached !== live;
}

export interface RefreshQueue<T> {
	/** Fetch and apply, coalescing concurrent calls into at most one extra run. */
	request(force?: boolean): Promise<void>;
}

/**
 * At most one fetch in flight; a request that lands during a fetch schedules
 * exactly one follow-up run (forced if any queued request asked for it). `canRun`
 * is checked before each fetch and before each follow-up, so a torn-down session
 * stops the loop instead of fetching into the void.
 */
export function createRefreshQueue<T>(deps: {
	fetch: (force: boolean) => Promise<T>;
	apply: (state: T) => void;
	canRun: () => boolean;
}): RefreshQueue<T> {
	let inFlight = false;
	let rerun = false;
	let rerunForce = false;
	return {
		async request(force = false): Promise<void> {
			if (!deps.canRun()) return;
			if (inFlight) {
				rerun = true;
				rerunForce = rerunForce || force;
				return;
			}
			inFlight = true;
			try {
				let nextForce = force;
				do {
					rerun = false;
					const useForce = nextForce || rerunForce;
					rerunForce = false;
					nextForce = false;
					deps.apply(await deps.fetch(useForce));
				} while (rerun && deps.canRun());
			} finally {
				inFlight = false;
			}
		},
	};
}
