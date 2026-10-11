// Windows keeps environment variables in the registry, not in startup files. A
// program started from Explorer (a new terminal) gets Windows' own variables,
// then the machine's, then the logon session's, then the user's, with the
// user's Path appended to the machine's. envhound reads those keys and replays
// that merge as a Trace: one assignment per registry value.
import { spawnSync } from "node:child_process";
import type { Assignment, Trace } from "../model.ts";

/** Where each value comes from, as shown to the user; MACHINE is abbreviated. */
export const MACHINE = "HKLM\\…\\Environment";
export const MACHINE_KEY =
	"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
export const SESSION = "HKCU\\Volatile Environment";
export const USER = "HKCU\\Environment";

export interface RegistryValue {
	name: string;
	/** RegistryValueKind: String (REG_SZ), ExpandString (REG_EXPAND_SZ), ... */
	kind: string;
	/** As stored: %VAR% references not expanded. */
	value: string;
}

/** Whose variables a change goes to: yours (HKCU), or the machine's (HKLM), for every user. */
export type Scope = "user" | "machine";

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
export function expand(
	s: string,
	get: (name: string) => string | undefined,
): string {
	return s.replace(/%([^%=]+)%/g, (m, name: string) => get(name) ?? m);
}

export function windowsTrace(
	reg: Registry,
	env: Record<string, string | undefined>,
): Trace {
	// by upper-case name: Windows ignores case; the first spelling seen is kept
	const values = new Map<string, { name: string; value: string }>();
	const get = (name: string) => values.get(name.toUpperCase())?.value;
	const set = (name: string, value: string) =>
		values.set(name.toUpperCase(), {
			name: values.get(name.toUpperCase())?.name ?? name,
			value,
		});
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
			const append =
				appendPath && v.name.toUpperCase() === "PATH" && !!previous;
			const result = append ? `${previous};${text}` : text;
			set(v.name, result);
			assignments.push({
				name: v.name,
				op: append ? "+=" : "=",
				value: v.value,
				previous,
				result,
				at: { file, line: 0 },
				local: false,
			});
		}
	};
	layer(MACHINE, reg.machine, false);
	layer(SESSION, reg.session, false);
	layer(USER, reg.user, true);

	const final = Object.fromEntries(
		[...values.values()].map((v) => [v.name, v.value]),
	);
	return { shell: "windows", initial, final, assignments };
}

// Prints the three keys as JSON, values as stored (%VAR% not expanded).
// The user's key is a parameter so tests can use a scratch key.
const READ = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = [ordered]@{}
foreach ($k in @(@('machine', ('HKLM:\\' + $env:ENVHOUND_MACHINE_KEY)), @('session', 'HKCU:\\Volatile Environment'), @('user', ('HKCU:\\' + $env:ENVHOUND_USER_KEY)))) {
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
export function powershellEnv(
	env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	const out = { ...process.env, ...env };
	for (const k of Object.keys(out))
		if (k.toUpperCase() === "PSMODULEPATH") delete out[k];
	return out;
}

/** Run a PowerShell script, passing `env` to it, and return its stdout. */
export function powershell(
	script: string,
	env: Record<string, string> = {},
): string {
	const r = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{
			env: powershellEnv(env),
			encoding: "utf8",
			windowsHide: true,
			timeout: 30_000,
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (r.error)
		throw new Error(`could not run powershell.exe: ${r.error.message}`);
	if (r.status !== 0)
		throw new Error(
			`powershell.exe failed: ${r.stderr.trim() || `exit status ${r.status}`}`,
		);
	return r.stdout;
}

/** The subkey of HKCU holding the user's variables. */
export const USER_KEY = "Environment";
/** The subkey of HKLM holding the machine's variables. */
export const MACHINE_SUBKEY =
	"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

/** The keys are parameters so tests can use scratch keys. */
export function readRegistry(
	userKey = USER_KEY,
	machineKey = MACHINE_SUBKEY,
): Registry {
	const out = JSON.parse(
		powershell(READ, {
			ENVHOUND_USER_KEY: userKey,
			ENVHOUND_MACHINE_KEY: machineKey,
		}).replace(/^﻿/, ""),
	) as Registry;
	return {
		machine: out.machine ?? [],
		session: out.session ?? [],
		user: out.user ?? [],
	};
}

export function traceWindows(
	env: Record<string, string | undefined> = process.env,
): Trace {
	return windowsTrace(readRegistry(), env);
}

/** One change to the user's variables; no value deletes it. */
export interface RegistryWrite {
	name: string;
	kind?: "String" | "ExpandString";
	value?: string;
}

// Backs up the key as a .reg file (double-click to restore), then writes. Values
// travel as JSON in an environment variable, so nothing needs quoting. The
// machine's key (HKLM) needs an administrator.
const WRITE = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$machine = $env:ENVHOUND_SCOPE -eq 'machine'
$hive = if ($machine) { 'HKLM' } else { 'HKCU' }
if ($env:ENVHOUND_BACKUP) {
  & reg.exe export ($hive + '\\' + $env:ENVHOUND_KEY) $env:ENVHOUND_BACKUP /y | Out-Null
  if ($LASTEXITCODE) { throw 'could not back up the key' }
}
$root = if ($machine) { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
$key = $root.CreateSubKey($env:ENVHOUND_KEY)
foreach ($w in (ConvertFrom-Json $env:ENVHOUND_WRITES)) {
  if ($null -eq $w.value) { $key.DeleteValue($w.name, $false) }
  else { $key.SetValue($w.name, [string]$w.value, [Microsoft.Win32.RegistryValueKind]$w.kind) }
}
$key.Close()
# .NET tells every window that the environment changed after any change to the
# variables, even deleting one that doesn't exist; Explorer then gives new
# terminals the new values
if ($env:ENVHOUND_NOTIFY) { [Environment]::SetEnvironmentVariable('ENVHOUND_NOTIFY', $null, $(if ($machine) { 'Machine' } else { 'User' })) }
`;

export function writeRegistry(
	writes: RegistryWrite[],
	opts: {
		backup?: string;
		scope?: Scope;
		/** the subkey written, for tests; by default the scope's Environment key */
		key?: string;
		notify?: boolean;
	} = {},
): void {
	const scope = opts.scope ?? "user";
	powershell(WRITE, {
		ENVHOUND_SCOPE: scope,
		ENVHOUND_KEY: opts.key ?? (scope === "machine" ? MACHINE_SUBKEY : USER_KEY),
		ENVHOUND_WRITES: JSON.stringify(writes),
		ENVHOUND_BACKUP: opts.backup ?? "",
		ENVHOUND_NOTIFY: opts.notify === false ? "" : "1",
	});
}

/** True when this process may write the machine's variables: an administrator terminal. */
export function isElevated(): boolean {
	const out = powershell(
		"([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
	);
	return out.trim() === "True";
}
