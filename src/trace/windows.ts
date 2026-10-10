// Windows keeps environment variables in the registry, not in startup files. A
// program started from Explorer (a new terminal) gets Windows' own variables,
// then the machine's, then the logon session's, then the user's, with the
// user's Path appended to the machine's. envhound reads those keys and replays
// that merge as a Trace: one assignment per registry value.
import { spawnSync } from "node:child_process";
import type { Assignment, Trace } from "../model.ts";

/** Where each value comes from, as shown to the user; MACHINE is abbreviated. */
export const MACHINE = "HKLM\\…\\Environment";
export const MACHINE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
export const SESSION = "HKCU\\Volatile Environment";
export const USER = "HKCU\\Environment";

export interface RegistryValue {
  name: string;
  /** RegistryValueKind: String (REG_SZ), ExpandString (REG_EXPAND_SZ), ... */
  kind: string;
  /** As stored: %VAR% references not expanded. */
  value: string;
}

export interface Registry {
  machine: RegistryValue[];
  session: RegistryValue[];
  user: RegistryValue[];
}

// Set by Windows itself before the Environment keys are read; taken from this process.
const FROM_WINDOWS = [
  "ALLUSERSPROFILE",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "COMPUTERNAME",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "SystemDrive",
  "SystemRoot",
  "USERDOMAIN_ROAMINGPROFILE",
];

/** %NAME% references replaced, as ExpandEnvironmentStrings does; unknown ones are kept. */
export function expand(s: string, get: (name: string) => string | undefined): string {
  return s.replace(/%([^%=]+)%/g, (m, name: string) => get(name) ?? m);
}

export function windowsTrace(reg: Registry, env: Record<string, string | undefined>): Trace {
  // by upper-case name: Windows ignores case; the first spelling seen is kept
  const values = new Map<string, { name: string; value: string }>();
  const get = (name: string) => values.get(name.toUpperCase())?.value;
  const set = (name: string, value: string) => values.set(name.toUpperCase(), { name: values.get(name.toUpperCase())?.name ?? name, value });
  const envKeys = new Map(Object.keys(env).map((k) => [k.toUpperCase(), k]));

  const initial: Record<string, string> = {};
  for (const name of FROM_WINDOWS) {
    const value = env[envKeys.get(name.toUpperCase()) ?? name];
    if (value === undefined) continue;
    initial[name] = value;
    set(name, value);
  }

  const assignments: Assignment[] = [];
  const layer = (file: string, vals: RegistryValue[], appendPath: boolean) => {
    // plain values first, then the ones that expand, so they can refer to the others
    const strings = vals.filter((v) => v.kind === "String");
    const expands = vals.filter((v) => v.kind === "ExpandString");
    for (const v of [...strings, ...expands]) {
      const text = v.kind === "ExpandString" ? expand(v.value, get) : v.value;
      const previous = get(v.name);
      const append = appendPath && v.name.toUpperCase() === "PATH" && !!previous;
      const result = append ? `${previous};${text}` : text;
      set(v.name, result);
      assignments.push({ name: v.name, op: append ? "+=" : "=", value: v.value, previous, result, at: { file, line: 0 }, local: false });
    }
  };
  layer(MACHINE, reg.machine, false);
  layer(SESSION, reg.session, false);
  layer(USER, reg.user, true);

  const final = Object.fromEntries([...values.values()].map((v) => [v.name, v.value]));
  return { shell: "windows", initial, final, assignments };
}

// Prints the three keys as JSON, values as stored (%VAR% not expanded).
// The user's key is a parameter so tests can use a scratch key.
const READ = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = [ordered]@{}
foreach ($k in @(@('machine', 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), @('session', 'HKCU:\\Volatile Environment'), @('user', ('HKCU:\\' + $env:ENVHOUND_USER_KEY)))) {
  $vals = New-Object System.Collections.ArrayList
  $key = Get-Item -LiteralPath $k[1] -ErrorAction SilentlyContinue
  if ($key) {
    foreach ($n in $key.GetValueNames()) {
      if ($n -eq '') { continue }
      [void]$vals.Add([ordered]@{ name = $n; kind = [string]$key.GetValueKind($n); value = [string]$key.GetValue($n, $null, 'DoNotExpandEnvironmentNames') })
    }
  }
  $out[$k[0]] = $vals
}
ConvertTo-Json -InputObject $out -Compress -Depth 4
`;

/**
 * The environment for Windows PowerShell: without PSModulePath, which PowerShell 7 sets
 * to its own modules, hiding Windows PowerShell's from a powershell.exe started from it.
 */
export function powershellEnv(env: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const out = { ...process.env, ...env };
  for (const k of Object.keys(out)) if (k.toUpperCase() === "PSMODULEPATH") delete out[k];
  return out;
}

/** Run a PowerShell script, passing `env` to it, and return its stdout. */
export function powershell(script: string, env: Record<string, string> = {}): string {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: powershellEnv(env),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`could not run powershell.exe: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`powershell.exe failed: ${r.stderr.trim() || `exit status ${r.status}`}`);
  return r.stdout;
}

/** The subkey of HKCU holding the user's variables. */
export const USER_KEY = "Environment";

export function readRegistry(userKey = USER_KEY): Registry {
  const out = JSON.parse(powershell(READ, { ENVHOUND_USER_KEY: userKey }).replace(/^﻿/, "")) as Registry;
  return { machine: out.machine ?? [], session: out.session ?? [], user: out.user ?? [] };
}

export function traceWindows(env: Record<string, string | undefined> = process.env): Trace {
  return windowsTrace(readRegistry(), env);
}

/** One change to the user's variables; no value deletes it. */
export interface RegistryWrite {
  name: string;
  kind?: "String" | "ExpandString";
  value?: string;
}

// Backs up the key as a .reg file (double-click to restore), then writes. Values
// travel as JSON in an environment variable, so nothing needs quoting.
const WRITE = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
if ($env:ENVHOUND_BACKUP) {
  & reg.exe export ('HKCU\\' + $env:ENVHOUND_USER_KEY) $env:ENVHOUND_BACKUP /y | Out-Null
  if ($LASTEXITCODE) { throw 'could not back up the key' }
}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:ENVHOUND_USER_KEY)
foreach ($w in (ConvertFrom-Json $env:ENVHOUND_WRITES)) {
  if ($null -eq $w.value) { $key.DeleteValue($w.name, $false) }
  else { $key.SetValue($w.name, [string]$w.value, [Microsoft.Win32.RegistryValueKind]$w.kind) }
}
$key.Close()
# .NET tells every window that the environment changed after any change to the
# user's variables, even deleting one that doesn't exist; Explorer then gives
# new terminals the new values
if ($env:ENVHOUND_NOTIFY) { [Environment]::SetEnvironmentVariable('ENVHOUND_NOTIFY', $null, 'User') }
`;

export function writeRegistry(writes: RegistryWrite[], opts: { backup?: string; userKey?: string; notify?: boolean } = {}): void {
  powershell(WRITE, {
    ENVHOUND_USER_KEY: opts.userKey ?? USER_KEY,
    ENVHOUND_WRITES: JSON.stringify(writes),
    ENVHOUND_BACKUP: opts.backup ?? "",
    ENVHOUND_NOTIFY: opts.notify === false ? "" : "1",
  });
}
