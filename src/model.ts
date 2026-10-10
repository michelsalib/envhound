export interface Location {
  /** A startup file, or on Windows a registry key such as HKCU\\Environment. */
  file: string;
  /** 0 for a registry key, which has no lines. */
  line: number;
}

/** How a traced line was reached: from inside a function, or at the top level of a sourced file. */
export interface Via {
  kind: "function" | "source";
  name: string;
  /** Where the function was called, or where the file was sourced. */
  at: Location;
}

export type Op = "=" | "+=" | "unset";

export interface Assignment {
  name: string;
  op: Op;
  /** Text assigned or appended (empty for unset). */
  value: string;
  /** Simulated value just before and just after this step (undefined = unset). */
  previous: string | undefined;
  result: string | undefined;
  at: Location;
  via?: Via;
  /** Assignment to a function-local variable: never visible outside the function. */
  local: boolean;
}

export interface Trace {
  /** windows: read from the registry, where names ignore case and PATH is split on ';'. */
  shell: "bash" | "windows";
  /** Environment the fresh shell was started with. */
  initial: Record<string, string>;
  /** Exported environment of the fresh shell once its startup files are done. */
  final: Record<string, string>;
  assignments: Assignment[];
}
