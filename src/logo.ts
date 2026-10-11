// The terminal version of assets/logo.svg: the hound, looking over a terminal at the prompt it has
// tracked down.

// Pixel art of the logo, drawn by hand. Each character of the banner shows two pixels stacked, the
// top one as a half block's foreground and the bottom one as its background, so every pixel has its
// own colour. "." is no pixel: the terminal's background shows.
const PIXELS = [
	"...........tttttttttt...........",
	".........tttttttttttttt.........",
	"........tttttttccttttttt........",
	"......tttttttttccttttttttt......",
	".....ttttttttttcctttttttttt.....",
	"...eetttttttttcccctttttttttee...",
	"..eeetttttttttccccttttttttteee..",
	"..eeetttbbbbttccccttbbbbttteee..",
	".eeeetttttttttccccttttttttteeee.",
	".eeeettttwddttccccttwddtttteeee.",
	".eeeettttdddttccccttdddtttteeee.",
	".eeeettttdddtcccccctdddtttteeee.",
	".eeeettttttttcccccctttttttteeee.",
	".eeeettttcccccddddccccctttteeee.",
	".eeeetttcccccddddddcccccttteeee.",
	".eeeetttcccccddddddcccccttteeee.",
	".eeeetttccccccddddccccccttteeee.",
	".eeeettttccdcccddcccdcctttteeee.",
	"..eeeeettcccdddppdddccctteeeee..",
	"..eeeeeettccccppppcccctteeeeee..",
	"...eeeeeetttccppppccttteeeeee...",
	"....eeTTTTTTttttttttTTTTTTee....",
	".ffffTTTTTTTffffffffTTTTTTTffff.",
	".fkkkTbTbTbTkkkkkkkkTbTbTbTkkkf.",
	".fkkkkkkkkkkkkkkkkkkkkkkkkkkkkf.",
	".fkkkkkkkkkkkkkkkkkkkkkkkkkkkkf.",
	".fkkkkkkkkkkkkkkkkkkkkkkkkkkkkf.",
	".ffffffffffffffffffffffffffffff.",
];
// [24-bit colour, closest xterm-256 colour] for each pixel letter
const PALETTE: Record<string, [string, number]> = {
	t: ["e08a3a", 173], // head
	T: ["e08a3a", 173], // paws
	e: ["8c4214", 94], // ears
	b: ["a8521a", 130], // brows, toes
	c: ["fbf1e3", 255], // blaze, muzzle
	d: ["2b1d14", 234], // eyes, nose, mouth
	w: ["ffffff", 231], // eye highlights
	p: ["f07c8a", 210], // tongue
	f: ["4a5266", 240], // the window's border
	k: ["0f1218", 233], // the window
};
const GREEN: [string, number] = ["7fd18b", 114];
// dark pixels, left out without colour so the face keeps its features
const DARK = "dwk";

const WIDTH = 32;
// the prompt sits inside the window, on its background; its cursor blinks where the terminal can
const PROMPT = { line: 12, col: 3 };

export interface BannerOptions {
	color: boolean;
	/** 24-bit colour; otherwise the closest xterm-256 colours */
	truecolor: boolean;
	/** terminal width: the text goes beside the logo when it fits, under it otherwise */
	columns?: number;
}

/** The logo, with `lines` beside it (or under it, on a narrow terminal). */
export function banner(lines: string[], o: BannerOptions): string {
	const sgr = ([hex, x256]: [string, number], layer: 38 | 48) =>
		o.truecolor
			? `${layer};2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4), 16)}`
			: `${layer};5;${x256}`;
	const on = (p: string) => p !== "." && (o.color || !DARK.includes(p));
	const cell = (top: string, bottom: string) => {
		if (!on(top) && !on(bottom)) return " ";
		if (!o.color) return on(top) ? (on(bottom) ? "█" : "▀") : "▄";
		if (!on(top)) return `\x1b[${sgr(PALETTE[bottom]!, 38)}m▄\x1b[0m`;
		const bg = on(bottom) ? `;${sgr(PALETTE[bottom]!, 48)}` : "";
		return `\x1b[${sgr(PALETTE[top]!, 38)}${bg}m▀\x1b[0m`;
	};
	const prompt = (ch: string, blink: boolean) =>
		o.color
			? `\x1b[1;${blink ? "5;" : ""}${sgr(GREEN, 38)};${sgr(PALETTE.k!, 48)}m${ch}\x1b[0m`
			: ch;
	const art: { out: string; width: number }[] = [];
	for (let line = 0; line * 2 < PIXELS.length; line++) {
		const top = PIXELS[line * 2]!;
		const bottom = PIXELS[line * 2 + 1] ?? ".".repeat(top.length);
		let out = "";
		for (let x = 0; x < top.length; x++) {
			if (line === PROMPT.line && x === PROMPT.col) out += prompt("$", false);
			else if (line === PROMPT.line && x === PROMPT.col + 1)
				out += prompt("_", true);
			else out += cell(top[x]!, bottom[x]!);
		}
		// trailing blanks dropped; the width is what is left, so the text beside lines up
		const trimmed = out.replace(/ +$/, "");
		art.push({
			out: trimmed,
			width: top.length - (out.length - trimmed.length),
		});
	}
	const top = Math.floor((art.length - lines.length) / 2);
	if ((o.columns || 80) < WIDTH + 6 + Math.max(...lines.map((l) => l.length))) {
		return (
			[
				...art.map((a) => `  ${a.out}`),
				"",
				...lines.map((l) => (l ? `  ${l}` : "")),
			].join("\n") + "\n"
		);
	}
	return (
		art
			.map((a, i) => {
				const text = lines[i - top];
				return text
					? `  ${a.out}${" ".repeat(WIDTH - a.width)}    ${text}`
					: `  ${a.out}`;
			})
			.join("\n") + "\n"
	);
}
