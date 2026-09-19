/**
 * quota-windows — 외부 쿼터 응답(JSON)을 5h/7d 게이지로 옮기는 순수 파싱.
 *
 * 경계 규율: 서버가 보내는 필드 이름·단위는 여기서 한 번만 해석한다. 푸터(extensions/)는
 * 이미 해석된 remainPct/resetsAt 만 본다. 엔드포인트마다 이름이 다르므로(five_hour.utilization,
 * rolling.percent, primary_window.used_percent) 파서를 한 곳에 모으고 실측 payload 로 고정한다.
 *
 * 남은 퍼센트의 정의는 하나다. remainPct = 100 - 사용률. 서버가 사용률을 보내면 여기서 뒤집는다.
 */

export interface QuotaWindow {
	label: "5h" | "7d" | "30d";
	remainPct: number;
	resetsAt: number;
}

/** 창 하나에서 남은 퍼센트를 읽는다. 서버마다 이름이 다르고, used_percent 는 뒤집어야 한다. */
function remainPctOf(w: any): number | null {
	if (!w) return null;
	if (w.percent_left != null) return Number(w.percent_left);
	if (w.remaining_percent != null) return Number(w.remaining_percent);
	if (w.used_percent != null) return 100 - Number(w.used_percent);
	return null;
}

/** 초/밀리초 혼용 타임스탬프를 ms 로. 1e11 초과는 이미 ms 로 본다. */
export function toMs(v: unknown): number {
	if (typeof v === "number") return v > 1e11 ? v : v * 1000;
	if (typeof v === "string") return new Date(v).getTime();
	return 0;
}

/** chatgpt.com/backend-api/wham/usage 의 rate_limit 창 — Codex 5h/7d. */
export function codexWindows(payload: unknown): QuotaWindow[] {
	const rl = ((payload as any)?.rate_limit ?? (payload as any)?.rate_limits ?? {}) as any;
	const out: QuotaWindow[] = [];
	const add = (label: QuotaWindow["label"], w: any) => {
		const remain = remainPctOf(w);
		if (remain == null || !Number.isFinite(remain)) return;
		out.push({ label, remainPct: Math.max(0, Math.min(100, remain)), resetsAt: toMs(w.reset_at ?? w.reset_time_ms) });
	};
	add("5h", rl.primary_window ?? rl.primary ?? rl.five_hour);
	add("7d", rl.secondary_window ?? rl.secondary ?? rl.weekly);
	return out;
}

/**
 * Cline Pass 구독의 사용량 창 — 5h/7d/30d. Cline 은 단일 usage 엔드포인트가 없다;
 * plan(한도) 과 usages(거래 내역) 둘을 합쳐 사용률을 구한다(extensions/fetchCline).
 *
 *   GET /api/v1/users/me/plan
 *     → data.plan.entitlements.cline_pass.inferenceCapThreshold
 *       = { last5HoursUsageCostUSDPerUser, last7daysUsageCostUSDPerUser,
 *           last30daysUsageCostUSDPerUser }  (한도, costUsd 단위)
 *   GET /api/v1/users/{uid}/usages
 *     → data.items[] ({ createdAt, costUsd })  (같은 costUsd 단위)
 *
 * 두 값을 **같은 단위**로 나눈다 — 서버가 한도와 사용량을 같은 costUsd 체계로 굽는다.
 * 창은 rolling(5h/7d/30d)이라 서버가 주는 리셋 시각이 없다 → resetsAt 0 (푸터가 꼬리를
 * 그리지 않는다). 구독이 아니거나 한도가 없으면 빈 배열(게이지 없음).
 */
const CLINE_WINDOWS = [
	{ label: "5h", ms: 5 * 60 * 60 * 1000, cap: "last5HoursUsageCostUSDPerUser" },
	{ label: "7d", ms: 7 * 24 * 60 * 60 * 1000, cap: "last7daysUsageCostUSDPerUser" },
	{ label: "30d", ms: 30 * 24 * 60 * 60 * 1000, cap: "last30daysUsageCostUSDPerUser" },
] as const;

export function clineWindows(planData: unknown, items: unknown, now: number = Date.now()): QuotaWindow[] {
	const caps = (planData as any)?.plan?.entitlements?.cline_pass?.inferenceCapThreshold;
	if (!caps || typeof caps !== "object") return [];
	const txns: { at: number; cost: number }[] = (Array.isArray(items) ? (items as any[]) : [])
		.map((t) => ({ at: Date.parse(t?.createdAt ?? ""), cost: Number(t?.costUsd) }))
		.filter((t) => Number.isFinite(t.at) && Number.isFinite(t.cost));
	const out: QuotaWindow[] = [];
	for (const w of CLINE_WINDOWS) {
		const cap = Number(caps[w.cap]);
		if (!(cap > 0) || !Number.isFinite(cap)) continue;
		const cut = now - w.ms;
		const used = txns.filter((t) => t.at >= cut).reduce((s, t) => s + t.cost, 0);
		const usedPct = Math.max(0, Math.min(100, (used / cap) * 100));
		out.push({ label: w.label, remainPct: Math.max(0, Math.min(100, 100 - usedPct)), resetsAt: 0 });
	}
	return out;
}

/**
 * opencode.ai/zen/go/v1/usage 의 usage 창 — OpenCode Go 5h/7d/30d(monthly).
 * 이 엔드포인트는 `percent` 를 **사용률**로 보낸다(다른 둘과 반대) — 여기서 뒤집는다.
 */
export function opencodeWindows(payload: unknown): QuotaWindow[] {
	const u = (((payload as any)?.usage ?? payload) ?? {}) as any;
	const out: QuotaWindow[] = [];
	const add = (label: QuotaWindow["label"], w: any) => {
		if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) return;
		out.push({ label, remainPct: Math.max(0, Math.min(100, 100 - w.percent)), resetsAt: toMs(w.resetsAt ?? w.resets_at) });
	};
	add("5h", u.rolling);
	add("7d", u.weekly);
	add("30d", u.monthly);
	return out;
}
