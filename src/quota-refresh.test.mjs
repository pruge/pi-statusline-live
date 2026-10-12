// quota-refresh 회귀 — /clear 같은 세션 교체가 만드는 "기본 provider 로 잠깐
// 떨어졌다 복원" 창에서도, 진행 중 fetch 를 드롭하지 않고 stale provider 의 쿼터를
// 화면에 남기지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshQueue, providerIsStale } from "./quota-refresh.ts";

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

test("providerIsStale — 둘 다 알고 다를 때만 stale", () => {
	assert.equal(providerIsStale("cline-bridge", "agnes"), true);
	assert.equal(providerIsStale("agnes", "agnes"), false);
	assert.equal(providerIsStale(undefined, "agnes"), false);
	assert.equal(providerIsStale("", "agnes"), false);
	assert.equal(providerIsStale("agnes", undefined), false, "live 를 모르면 변경의 증거가 없다");
	assert.equal(providerIsStale("agnes", ""), false);
});

test("createRefreshQueue — in-flight 중 요청을 드롭하지 않고 정확히 한 번 더 돈다", async () => {
	const d1 = deferred();
	const d2 = deferred();
	const calls = [];
	const applied = [];
	let n = 0;
	const q = createRefreshQueue({
		fetch: (force) => { calls.push(force); n += 1; return (n === 1 ? d1 : d2).promise; },
		apply: (state) => applied.push(state),
		canRun: () => true,
	});

	const p1 = q.request(false); // fetch #1 시작
	const p2 = q.request(true);  // 큐잉(force)
	const p3 = q.request(false); // 또 큐잉 — 그래도 추가 런은 하나
	assert.equal(calls.length, 1, "동시 fetch 는 하나뿐");

	d1.resolve("A");
	await tick();
	assert.equal(calls.length, 2, "큐에 남은 요청이 fetch #2 를 띄운다");
	assert.equal(calls[1], true, "큐에 force 가 있으면 다음 런은 force");

	d2.resolve("B");
	await p1; await p2; await p3;
	assert.deepEqual(applied, ["A", "B"], "적용은 fetch 순서대로");
});

test("createRefreshQueue — canRun 이 false 면 fetch 하지 않는다", async () => {
	let fetched = 0;
	const q = createRefreshQueue({
		fetch: async () => { fetched += 1; return 1; },
		apply: () => {},
		canRun: () => false,
	});
	await q.request(true);
	assert.equal(fetched, 0);
});

test("createRefreshQueue — 런 중 canRun 이 꺼지면 추가 런을 멈춘다", async () => {
	const d = deferred();
	let can = true;
	let fetched = 0;
	const q = createRefreshQueue({
		fetch: () => { fetched += 1; return d.promise; },
		apply: () => {},
		canRun: () => can,
	});

	const p1 = q.request(false);
	const p2 = q.request(true); // 큐잉
	can = false;                // 세션이 찢어짐
	d.resolve("X");
	await p1; await p2;
	assert.equal(fetched, 1, "canRun 이 꺼지면 rerun 하지 않는다");
});

test("createRefreshQueue — 앞 런이 끝난 뒤의 요청은 곧바로 새 런이 된다", async () => {
	const calls = [];
	const applied = [];
	const q = createRefreshQueue({
		fetch: async (force) => { calls.push(force); return calls.length; },
		apply: (state) => applied.push(state),
		canRun: () => true,
	});
	await q.request(false);
	await q.request(true);
	assert.deepEqual(calls, [false, true]);
	assert.deepEqual(applied, [1, 2]);
});
