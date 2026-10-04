// The terminal version of assets/logo.svg: the hound, and the prompt it has tracked down.

// Generated from assets/logo.svg: each character is a quarter-block (2x2 pixels), coloured by INK.
const ART = [
  "          ▗▟████▙▖",
  "     ▗▄▄▟██████████▙▄▄▖",
  "    ▟██████████████████▙",
  "  ▗▟████████████████████▙▖",
  "  ████████████████████████",
  " ▐███████ ▟▖▜██▛▗▙ ███████▌",
  " █████████▙▟████▙▟█████████",
  "▐██████████████████████████▌",
  "████████████████████████████",
  "████████████████████████████",
  "▐██████████████████████████▌",
  "▐██████████▌    ▐██████████▌",
  "▝███████████▙▄▄▟███████████▘",
  "  ▀█▛▀▀ ▀█▛▀▀▀▀▀▀▜█▀ ▀▀▜█▀",
];
// for each character of ART, its colour in PALETTE
const INK = [
  "          33333333",
  "     222233333333332222",
  "    22223333366333332222",
  "  022000333336633333000220",
  "  000000033336633330000000",
  " 00000001 88666688 10000000",
  " 00000001144666644110000000",
  "0000000015556666555100000000",
  "0000000115566666655110000000",
  "0000000115766666675110000000",
  "0000000167766666677610000000",
  "000000116676    676611000000",
  "0000011666666666666661100000",
  "  00111 666666666666 11100",
];
// [24-bit colour, closest xterm-256 colour] for terminals without 24-bit colour
const PALETTE: [string, number][] = [["a8521a", 130], ["8c4214", 130], ["c0631f", 166], ["e08a3a", 172], ["d07a2c", 172], ["c76f26", 166], ["fbf1e3", 255], ["eedcc6", 252], ["7fd18b", 114]];

const WIDTH = 29;
// the prompt sits at the bottom-right, like in the logo; its cursor blinks where the terminal can
const PROMPT = { row: 13, col: 27 };

export interface BannerOptions {
  color: boolean;
  /** 24-bit colour; otherwise the closest xterm-256 colours */
  truecolor: boolean;
  /** terminal width: the text goes beside the logo when it fits, under it otherwise */
  columns?: number;
}

/** The logo, with `lines` beside it (or under it, on a narrow terminal). */
export function banner(lines: string[], o: BannerOptions): string {
  const ink = (i: number) => {
    const [hex, x256] = PALETTE[i]!;
    if (!o.truecolor) return `38;5;${x256}`;
    return `38;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4), 16)}`;
  };
  const paint = (code: string, s: string) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const green = ink(PALETTE.length - 1);
  const art = ART.map((row, i) => {
    let out = "";
    for (let j = 0; j < row.length; ) {
      // a run of characters that share a colour
      const k0 = INK[i]![j]!;
      let k = j + 1;
      while (k < row.length && INK[i]![k] === k0) k++;
      out += k0 === " " ? row.slice(j, k) : paint(ink(parseInt(k0, 36)), row.slice(j, k));
      j = k;
    }
    if (i === PROMPT.row) out += " ".repeat(PROMPT.col - row.length) + paint(`1;${green}`, "$") + paint(`1;5;${green}`, "_");
    return { out, width: i === PROMPT.row ? PROMPT.col + 2 : row.length };
  });
  const top = Math.floor((ART.length - lines.length) / 2);
  if ((o.columns || 80) < WIDTH + 6 + Math.max(...lines.map((l) => l.length))) {
    return [...art.map((a) => `  ${a.out}`), "", ...lines.map((l) => (l ? `  ${l}` : ""))].join("\n") + "\n";
  }
  return (
    art
      .map((a, i) => {
        const text = lines[i - top];
        return text ? `  ${a.out}${" ".repeat(WIDTH - a.width)}    ${text}` : `  ${a.out}`;
      })
      .join("\n") + "\n"
  );
}
