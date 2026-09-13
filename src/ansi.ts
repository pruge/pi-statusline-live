/**
 * ANSI 색 강등 — 테마가 truecolor(ESC[38;2;R;G;B) 를 내도 터미널/중간 계층이 그것을 삼키면
 * 화면에는 **일반 텍스트 색**으로 뜬다(pi 의 dark 테마 success = 38;2;181;189;104 실측).
 * herdr · tmux · TERM=vt100 등에서 벌어진다. 그래서 판정을 색에만 싣지 않고, 낼 수 있는 색으로
 * 한 단계 내려서 보낸다: truecolor → 256(xterm 큐브) → 16(기본).
 */
export type ColorMode = "truecolor" | "256" | "16" | "none";

export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
	const ct = (env.COLORTERM ?? "").toLowerCase();
	if (ct === "truecolor" || ct === "24bit") return "truecolor";
	const term = (env.TERM ?? "").toLowerCase();
	if (/256/.test(term)) return "256";
	if (/color|ansi|screen|xterm|vt1/.test(term)) return "16";
	return env.TERM ? "16" : "none";
}

function rgbTo256(r: number, g: number, b: number): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : v < 155 ? 2 : v < 200 ? 3 : v < 232 ? 4 : 5);
	return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** 16색으로는 색상을 보존할 수 없다. 대신 "어느 색짜리인가"와 "밝기"는 남긴다 (dim → 90). */
function rgbTo16(r: number, g: number, b: number): number {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return l >= 190 ? 37 : 90;
	const hi = l > 128;
	let cat: number;
	if (max === r && max === g) cat = 3;
	else if (max === r && max === b) cat = 5;
	else if (max === g && max === b) cat = 6;
	else if (max === r) cat = 1;
	else if (max === g) cat = 2;
	else cat = 4;
	const base = [30, 31, 32, 33, 34, 35, 36, 37][cat];
	return cat === 3 || cat === 6 || cat === 7 ? base : base + (hi ? 60 : 0);
}

const TC = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;

/** 문자열 안의 truecolor_foreground 시퀀스만 mode 에 맞게 바꾼다(나머지는 그대로). */
export function downgradeAnsi(s: string, mode: ColorMode): string {
	if (!s || mode === "truecolor") return s;
	if (mode === "none") return s.replace(TC, "");
	return s.replace(TC, (_m, r, g, b) => {
		const R = Number(r), G = Number(g), B = Number(b);
		return mode === "256" ? `\x1b[38;5;${rgbTo256(R, G, B)}m` : `\x1b[${rgbTo16(R, G, B)}m`;
	});
}
