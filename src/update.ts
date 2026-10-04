// Weekly update check. The registry is asked at most once a week, by a detached
// background process, so no command waits on the network; a later run prints the notice.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const REPO = "michelsalib/envhound";
const REGISTRY = "https://registry.npmjs.org/envhound/latest";
export const WEEK = 7 * 24 * 3600 * 1000;

/** How this copy of envhound was installed, which decides how to update it. */
export type InstallKind = "npx" | "bunx" | "bun" | "npm" | "standalone" | "dev";

export function installKind(script: string): InstallKind {
  const p = script.replaceAll("\\", "/");
  if (p.includes("/_npx/")) return "npx";
  if (p.includes("/bunx-")) return "bunx";
  if (p.includes("/.bun/install/global/")) return "bun";
  if (p.includes("/node_modules/")) return "npm";
  // a checkout: src/cli.ts or dist/envhound.js; install.sh installs a file named plain `envhound`
  if (/\.[cm]?[jt]s$/.test(p)) return "dev";
  return "standalone";
}

export function upgradeCommand(kind: InstallKind): string {
  switch (kind) {
    case "npx":
      return "npx envhound@latest";
    case "bunx":
      return "bunx envhound@latest";
    case "bun":
      return "bun add -g envhound@latest";
    case "npm":
      return "npm install -g envhound@latest";
    case "standalone":
      return "envhound upgrade";
    case "dev":
      return "git pull && bun run build";
  }
}

/** True when version `a` is newer than `b`; only major.minor.patch counts. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => (v.match(/^v?(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const [x, y] = [parse(a), parse(b)];
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

export interface UpdateState {
  /** when the registry was last asked (ms) */
  checkedAt?: number;
  /** the latest version it reported */
  latest?: string;
  /** when the notice was last shown (ms) */
  notifiedAt?: number;
}

/** Pure decision: ask the registry now? show the notice now? */
export function decide(state: UpdateState, current: string, now: number): { check: boolean; notify: boolean } {
  const due = (t?: number) => t === undefined || now - t >= WEEK || t > now;
  return {
    check: due(state.checkedAt),
    notify: state.latest !== undefined && newer(state.latest, current) && due(state.notifiedAt),
  };
}

export function readState(file: string): UpdateState {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return typeof s === "object" && s ? s : {};
  } catch {
    return {};
  }
}

function writeState(file: string, state: UpdateState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state) + "\n");
  renameSync(tmp, file);
}

/**
 * Called at the start of a command. Starts a background check when one is due and
 * returns the notice to print at the end, if a newer version is known and the
 * notice wasn't shown this week. Never throws: an update check must not break a command.
 */
export function updateNotice(current: string, script: string, stateFile: string, now = Date.now()): string | undefined {
  try {
    const kind = installKind(realpathSync(script));
    if (kind === "dev") return undefined;
    const state = readState(stateFile);
    const { check, notify } = decide(state, current, now);
    if (check) {
      // recorded first, so a failing network doesn't start a check on every run
      writeState(stateFile, { ...state, checkedAt: now });
      spawn(process.execPath, [script, "__update-check", stateFile], { detached: true, stdio: "ignore" }).unref();
    }
    if (!notify) return undefined;
    writeState(stateFile, { ...readState(stateFile), notifiedAt: now });
    return `envhound ${state.latest} is available (you have ${current}). Update with: ${upgradeCommand(kind)}`;
  } catch {
    return undefined;
  }
}

/** The hidden `__update-check` command, run in the background by updateNotice. */
export async function fetchLatest(stateFile: string): Promise<void> {
  const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!res.ok) return;
  const { version } = (await res.json()) as { version?: unknown };
  if (typeof version !== "string") return;
  writeState(stateFile, { ...readState(stateFile), checkedAt: Date.now(), latest: version });
}

/** Where release files are downloaded from; ENVHOUND_BASE_URL overrides it (mirrors, tests). */
export function installerUrl(env: Record<string, string | undefined>): string {
  return `${env.ENVHOUND_BASE_URL ?? `https://github.com/${REPO}/releases/latest/download`}/install.sh`;
}
