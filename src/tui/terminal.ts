// Terminal driver for `rcenv edit`: raw keys in, full redraws out, on the
// alternate screen so the user's scrollback is left as it was.
import { spawnSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import type { Location } from "../model.ts";
import type { EditOp } from "../set.ts";
import { handleKey, initialState, type Data, type Key } from "./state.ts";
import { render } from "./view.ts";

const ENTER = "\x1b[?1049h\x1b[?25l"; // alternate screen, hide cursor
const LEAVE = "\x1b[?25h\x1b[?1049l";

/** Command line opening `file` at `line` in the user's editor. */
export function editorCommand(editor: string, at: Location): [string, string[]] {
  const [cmd = "vi", ...args] = editor.trim().split(/\s+/);
  const base = cmd.split("/").pop() ?? cmd;
  // VS Code and its forks take file:line; vi, vim, nvim, nano, emacs, micro take +line
  if (/^(code|code-insiders|codium|cursor|windsurf)$/.test(base)) {
    return [cmd, [...args.filter((a) => a !== "--wait"), "--wait", "-g", `${at.file}:${at.line}`]];
  }
  return [cmd, [...args, `+${at.line}`, at.file]];
}

/**
 * Run the editor until the user writes or quits. Returns the staged ops to
 * write, or undefined. `load` is called again after the user edits a file.
 */
export function runEditor(load: () => Data, opts: { color: boolean; showSecrets: boolean }): Promise<EditOp[] | undefined> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let state = initialState(load(), opts.showSecrets);

  return new Promise((resolve, reject) => {
    const draw = () => {
      const width = stdout.columns || 80;
      const height = stdout.rows || 24;
      state = { ...state, pageSize: Math.max(1, height - 8) };
      const lines = render(state, width, height, { color: opts.color });
      stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J");
    };
    const start = () => {
      stdout.write(ENTER);
      stdin.setRawMode(true);
      stdin.resume();
      draw();
    };
    const stop = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(LEAVE);
    };
    const finish = (result: EditOp[] | undefined) => {
      stdin.off("keypress", onKey);
      stdout.off("resize", draw);
      stop();
      resolve(result);
    };

    const openEditor = (at: Location) => {
      stop();
      const [cmd, args] = editorCommand(process.env.VISUAL || process.env.EDITOR || "vi", at);
      const r = spawnSync(cmd, args, { stdio: "inherit" });
      start();
      if (r.error) {
        state = { ...state, message: { text: `could not run ${cmd}: ${r.error.message}`, error: true } };
      } else {
        stdout.write("\x1b[H\x1b[Jreloading…");
        state = { ...state, data: load(), message: { text: "reloaded after editing" } };
      }
      draw();
    };

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
      try {
        const printable = str && !key?.ctrl && !key?.meta && [...str].length === 1 && str >= " " && str !== "\x7f" ? str : undefined;
        const k: Key = { name: key?.name, ch: printable, ctrl: key?.ctrl };
        const [next, effect] = handleKey(state, k);
        state = next;
        if (effect?.kind === "quit") return finish(undefined);
        if (effect?.kind === "write") return finish(state.ops);
        if (effect?.kind === "open") return openEditor(effect.at);
        draw();
      } catch (e) {
        stdin.off("keypress", onKey);
        stop();
        reject(e);
      }
    };

    emitKeypressEvents(stdin);
    stdin.on("keypress", onKey);
    stdout.on("resize", draw);
    start();
  });
}
