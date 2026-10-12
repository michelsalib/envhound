// envhound --help: an overview of the commands, and envhound COMMAND --help (or envhound help
// COMMAND) for one command alone: its usage, what it does, the options it takes, examples.

/** Every option, as the help lists it. */
const OPTIONS: Record<string, [string, string]> = {
	json: ["--json", "machine-readable output"],
	"show-secrets": [
		"--show-secrets",
		"don't mask values of variables like *_TOKEN, *_KEY or *_PAT,\nor passwords in URLs (postgres://user:********@host)",
	],
	home: [
		"--home DIR",
		"act as if HOME were DIR (on Windows: only for backups)",
	],
	shell: [
		"--shell bash|zsh",
		"replay this shell instead of your login shell ($SHELL)",
	],
	file: ["-f, --file FILE", "edit this .env file instead of the shell"],
	yes: ["-y, --yes", "write without asking"],
	"dry-run": ["--dry-run", "show the diff, write nothing"],
	append: ["--append", "put DIR at the end of PATH instead of the front"],
	stdin: [
		"--stdin",
		"read the value from standard input, or type it unseen at a\nterminal: it stays out of your history and the process list",
	],
	help: ["-h, --help", "show help: envhound COMMAND --help for one command"],
	version: ["-v, --version", "show the version"],
};

export interface CommandHelp {
	/** Usage lines, without "envhound ". */
	usage: string[];
	/** One line for the overview. */
	summary: string;
	/** The overview's usage, when shorter than the first usage line. */
	brief?: string;
	/** What it does, in a few lines. */
	about: string;
	/** Keys of OPTIONS it takes, besides --help. */
	options: string[];
	examples: string[];
	/** Where the overview lists it. */
	group: "read" | "change" | "more";
}

const WRITES = `Changes go to envhound's own file, ~/.config/envhound/env.sh, loaded by one line
envhound adds to your login file (~/.zprofile for zsh, else the one bash reads).
On Windows they go to your user variables (HKCU\\Environment). Every change is
shown as a diff and confirmed first; changed files are backed up.`;

const TRACED = ["home", "shell"];

export const COMMAND_HELP: Record<string, CommandHelp> = {
	list: {
		group: "read",
		usage: ["[list]"],
		summary: "every variable, with the startup file:line that sets it",
		about: `Lists every variable of this shell, with the startup file and line that set
it, or where else it comes from: the login, the shell itself, or whatever
started this shell. Values that differ from what a new shell gets are marked.
This is what envhound does with no command.`,
		options: ["json", "show-secrets", ...TRACED],
		examples: ["envhound", "envhound list --json"],
	},
	blame: {
		group: "read",
		usage: ["blame VAR"],
		summary: "every startup file:line that assigns VAR, in order",
		about: `Shows every line of your startup files that assigns VAR, in the order they run,
and whether the last one is what a new shell ends up with. For PATH, what each
step added or removed.`,
		options: ["json", "show-secrets", ...TRACED],
		examples: ["envhound blame PATH", "envhound blame EDITOR"],
	},
	why: {
		group: "read",
		usage: ["why COMMAND"],
		summary: "which file COMMAND runs, and the line behind it",
		about: `Shows which file COMMAND runs, the PATH entry it comes from and the startup line
that added that entry, the files of the same name it hides, and whether a new
shell would run another one. Exits 1 when COMMAND is not in PATH.`,
		options: ["json", ...TRACED],
		examples: ["envhound why python3", "envhound why node --json"],
	},
	path: {
		group: "read",
		usage: ["path", "path add DIR... [--append]", "path remove DIR..."],
		summary: "PATH entry by entry: who added each, missing, duplicates",
		about: `Lists this shell's PATH one entry per line, with the startup line that added
each, and flags directories that don't exist and duplicates.
path add and path remove change PATH for new shells: envhound path add --help.`,
		options: ["json", ...TRACED],
		examples: ["envhound path", "envhound path --json"],
	},
	"path add": {
		group: "change",
		usage: ["path add DIR... [--append]"],
		brief: "path add DIR...",
		summary: "put a directory in PATH for new shells",
		about: `Puts each DIR in PATH for new shells, at the front, or at the end with --append.
${WRITES}`,
		options: ["append", "yes", "dry-run", ...TRACED],
		examples: [
			"envhound path add ~/bin",
			"envhound path add ~/tools --append --dry-run",
		],
	},
	"path remove": {
		group: "change",
		usage: ["path remove DIR..."],
		summary: "take a directory out of PATH",
		about: `Takes each DIR out of PATH for new shells: the line envhound added, or on
Windows the directory in your variables or the machine's (asking for
administrator rights when needed). A line in another startup file is named, for
you to remove.
${WRITES}`,
		options: ["yes", "dry-run", ...TRACED],
		examples: ["envhound path remove ~/old/bin"],
	},
	doctor: {
		group: "read",
		usage: ["doctor"],
		summary: "every problem with your environment, each with its fix",
		about: `Lists every problem with the environment a new shell gets, with the startup line
it comes from and how to fix it: PATH entries that are missing, duplicated,
relative or writable by anyone, version managers fighting over a language,
variables not exported or set in several files, secrets in readable files.
Exits 1 when there are errors.`,
		options: ["json", ...TRACED],
		examples: ["envhound doctor", "envhound doctor --json"],
	},
	dotenv: {
		group: "read",
		usage: ["dotenv [FILE...]"],
		summary: "check .env files against your shell",
		about: `Checks .env files (./.env by default): keys that are new, already set the same
in your shell, or in conflict with it (with the startup line behind the shell's
value), and syntax problems. Exits 1 when there are problems.`,
		options: ["json", "show-secrets", ...TRACED],
		examples: ["envhound dotenv", "envhound dotenv .env .env.local"],
	},
	set: {
		group: "change",
		usage: [
			"set NAME=value...",
			"set NAME --stdin",
			"set --file FILE NAME=value...",
		],
		summary: "set variables for new shells, or in a .env file",
		about: `Sets each NAME for new shells; envhound's line runs last, so it wins in login
shells, and envhound says when another startup line would still override it.
With --file, sets keys in that .env file instead.
${WRITES}`,
		options: ["stdin", "file", "yes", "dry-run", "show-secrets", ...TRACED],
		examples: [
			"envhound set EDITOR=vim",
			"envhound set GH_TOKEN --stdin",
			"envhound set --file .env PORT=3000",
		],
	},
	unset: {
		group: "change",
		usage: ["unset NAME...", "unset --file FILE NAME..."],
		summary: "remove variables envhound set, or keys of a .env file",
		about: `Removes each NAME envhound set. A line in another startup file is named, for
you to remove; on Windows the machine's variables are changed too (asking for
administrator rights when needed). With --file, removes keys from that .env
file.
${WRITES}`,
		options: ["file", "yes", "dry-run", ...TRACED],
		examples: ["envhound unset EDITOR", "envhound unset --file .env OLD_KEY"],
	},
	edit: {
		group: "change",
		usage: ["edit [FILE...]"],
		summary: "interactive editor for variables, PATH and .env files",
		about: `Opens an editor with tabs for your variables, PATH, and each .env file (./.env
when it exists): stage changes, then w to review them as a diff and write.
? inside it lists the keys. Needs a terminal.`,
		options: ["file", "yes", "dry-run", "show-secrets", ...TRACED],
		examples: ["envhound edit", "envhound edit .env.local"],
	},
	completion: {
		group: "more",
		usage: ["completion bash|zsh|fish|powershell"],
		brief: "completion SHELL",
		summary: "print a shell completion script",
		about: `Prints a completion script for that shell: commands, options, and live variable
names. Load it from your shell's startup file.`,
		options: [],
		examples: [
			'eval "$(envhound completion bash)"        # in ~/.bashrc',
			'eval "$(envhound completion zsh)"         # in ~/.zshrc, after compinit',
			"envhound completion fish | source        # in ~/.config/fish/config.fish",
			"envhound completion powershell | Out-String | Invoke-Expression  # $PROFILE",
		],
	},
	upgrade: {
		group: "more",
		usage: ["upgrade"],
		summary: "update envhound to the latest release",
		about: `Replaces this envhound with the latest release when it was installed with
install.sh or install.ps1 (the script or the standalone binary); the download
must match the release's SHA256SUMS and the npm package. Other installs get the
command to run (npm, bun, Homebrew, Scoop…).`,
		options: [],
		examples: ["envhound upgrade"],
	},
	help: {
		group: "more",
		usage: ["help [COMMAND]"],
		summary: "this help, or one command's",
		about:
			"Shows the list of commands, or one command's usage, options and examples.",
		options: [],
		examples: ["envhound help set", "envhound path add --help"],
	},
};

/** The help topic for these positionals: "path add" for path add, else the command. */
export function helpTopic(positionals: string[]): string | undefined {
	const [command, sub] = positionals;
	if (command === undefined) return undefined;
	if (command === "path" && (sub === "add" || sub === "remove"))
		return `path ${sub}`;
	return command;
}

function options(keys: string[]): string {
	const rows = [...keys, "help"].map((k) => OPTIONS[k]!);
	const w = Math.max(...rows.map(([flag]) => flag.length));
	return rows
		.map(([flag, text]) => {
			const [first, ...rest] = text.split("\n");
			return [
				`  ${flag.padEnd(w)}  ${first}`,
				...rest.map((l) => `  ${" ".repeat(w)}  ${l}`),
			].join("\n");
		})
		.join("\n");
}

/** One command's help, or undefined for a command there is none. */
export function commandHelp(topic: string): string | undefined {
	const h = COMMAND_HELP[topic];
	if (!h) return undefined;
	const usage = h.usage.map(
		(u, i) => `${i ? "       " : "Usage: "}envhound ${u}`,
	);
	return `${usage.join("\n")}

${h.about}

Options:
${options(h.options)}

Examples:
${h.examples.map((e) => `  ${e}`).join("\n")}
`;
}

/** envhound --help: every command in one line, by what it is for. */
export function overview(): string {
	const all = Object.values(COMMAND_HELP);
	const brief = (h: CommandHelp) => h.brief ?? h.usage[0]!;
	// one column width for every group, so the summaries line up
	const w = Math.max(...all.map((h) => brief(h).length));
	const group = (g: CommandHelp["group"]) =>
		all
			.filter((h) => h.group === g)
			.map((h) => `  ${brief(h).padEnd(w)}  ${h.summary}`)
			.join("\n");
	return `Usage: envhound [COMMAND] [OPTIONS]

See where your environment comes from:
${group("read")}

Change it:
${group("change")}

More:
${group("more")}

Options for every command:
${options(["home", "shell", "version"])}

envhound COMMAND --help shows a command's options and examples.

envhound replays your login shell (bash or zsh; bash for any other) from a clean
environment with tracing on, so it only sees what startup files do; that runs
your startup files once. On Windows it reads the registry instead.
Once a week it asks npm in the background whether a newer version exists;
ENVHOUND_NO_UPDATE_CHECK=1 turns this off.

From the same pack: netbeagle, what listens on each port and who reaches it.
  npx netbeagle
`;
}
