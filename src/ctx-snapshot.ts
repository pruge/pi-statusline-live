/**
 * ctx-snapshot — 세션별 컨텍스트 스냅샷의 파일 계약.
 *
 * statusline(pi-statusline-live)이 쓰고, orch(tf_status·idle 워치)가 읽는다.
 * 패키지 간 import 금지 원칙에 따라 경계는 파일이다:
 *
 *   dir:   ~/.pi/agent/ctx-sessions/
 *   file:  <key>.json   (key = HERDR_PANE_ID ?? PI_SESSION_ID ?? pid-<pid>)
 *   shape: { v:1, pane?, session?, cwd, model?, provider?, pct, cur, win, at(ISO) }
 *
 * TTL 30분. 쓰는 쪽이 쓸 때마다, 읽는 쪽이 읽을 때마다 오래된 것을 버린다/무시한다.
 * 동시 쓰기 경합이 없게 세션당 파일 하나(merge 없음) + tmp+rename 원자 쓰기.
 */

export const CTX_TTL_MS = 30 * 60_000;

export interface CtxEntry {
	v: 1;
	pane?: string;
	session?: string;
	cwd: string;
	model?: string;
	provider?: string;
	pct: number;
	cur: number;
	win: number;
	at: string;
}

/** 파일명에 못 쓰는 문자(/ 등)는 - 로. pane 의 : 은 살린다(w9B:p1). */
export function sanitizeKey(k: string): string {
	return String(k ?? "").replace(/[^A-Za-z0-9_.:#-]/g, "-").slice(0, 128) || "unknown";
}

/** 이 세션의 파일 키. 조인 키(workerPane)와 같은 값이어야 orch 가 매칭할 수 있다. */
export function snapshotKey(env: NodeJS.ProcessEnv = process.env): string {
	const k = env.HERDR_PANE_ID?.trim() || env.PI_SESSION_ID?.trim() || `pid-${process.pid}`;
	return sanitizeKey(k);
}

/** prune 대상 선별(순수). at 파싱 실패도 정리 대상 — 신뢰할 수 없는 건 slim 대상이다. */
export function staleNames(files: Array<{ name: string; at?: string }>, now = Date.now(), ttlMs = CTX_TTL_MS): string[] {
	return (files ?? [])
		.filter((f) => {
			const t = Date.parse(String(f.at ?? ""));
			return !Number.isFinite(t) || now - t > ttlMs;
		})
		.map((f) => f.name);
}
