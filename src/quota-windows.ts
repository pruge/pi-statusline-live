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
	label: "5h" | "7d";
	remainPct: number;
	resetsAt: number;
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
	const pct = (l: any) => l?.percent_left != null ? Number(l.percent_left) : l?.remaining_percent != null ? Number(l.remaining_percent) : null;
	const prim = rl.primary_window ?? rl.primary ?? rl.five_hour;
	const sec = rl.secondary_window ?? rl.secondary ?? rl.weekly;
	if (prim && pct(prim) != null) out.push({ label: "5h", remainPct: Math.max(0, pct(prim)!), resetsAt: toMs(prim.reset_at ?? prim.reset_time_ms) });
	if (sec && pct(sec) != null) out.push({ label: "7d", remainPct: Math.max(0, pct(sec)!), resetsAt: toMs(sec.reset_at ?? sec.reset_time_ms) });
	return out;
}
