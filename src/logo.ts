// The terminal version of assets/logo.svg: the fox head, and the prompt it has tracked down.

// Generated from assets/logo.svg: each character is a quarter-block (2x2 pixels), coloured by INK.
const ART = [
  "     ▗▙              ▟▖",
  "     ▐▖▀▄          ▄▀▗▌",
  "     ▐▌▙▝▜▖      ▗▛▘▟▐▌",
  "     █▌█▙ ████████ ▟█▐█",
  "     █▙█▄██████████▄█▟█",
  "    ▗██████████████████▖",
  "   ▟███▖▜▀████████▀▛▗███▙",
  " ▗▟█████▄▄▄██████▄▄▄█████▙▖",
  "▗██████████████████████████▖",
  "   ▝▀▜████████████████▛▀▘",
  "      ▝▜████████████▛▘",
  "        ▝▜██▛▀▀▜██▛▘",
  "          ▝▜█▄▄█▛▘",
  "            ▝▜▛▘",
];
// for each character of ART, its colour in PALETTE
const INK = [
  "     00              00",
  "     0500          0000",
  "     021500      000120",
  "     0311 32222223 1130",
  "     002242222222242200",
  "    33333342222224333333",
  "   3005599534444359955003",
  " 66712059555444455595021766",
  "6666667112453443542117666666",
  "   6677777748888477777766",
  "      7777728888277777",
  "        777138831777",
  "          66666666",
  "            6666",
];
// [24-bit colour, closest xterm-256 colour] for terminals without 24-bit colour
const PALETTE: [string, number][] = [["e9801c", 172], ["e7d3bb", 187], ["f8a53a", 215], ["ee8d22", 208], ["f6a034", 215], ["e47a16", 172], ["fbf1e3", 255], ["eedcc6", 253], ["d96b12", 166], ["7fd18b", 114]];

const WIDTH = 28;
// the prompt sits at the bottom-right, like in the logo; its cursor blinks where the terminal can
const PROMPT = { row: 11, col: 22 };

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
