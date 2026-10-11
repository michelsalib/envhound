import { expect, test } from "bun:test";
import { packageFiles } from "../scripts/packages.ts";

const NAMES = [
	"envhound-darwin-arm64",
	"envhound-darwin-x64",
	"envhound-linux-arm64",
	"envhound-linux-x64",
	"envhound-windows-x64.exe",
];
const sums = NAMES.map((n, i) => `${String(i).repeat(64)}  ${n}\n`).join("");

test("Homebrew, Scoop and winget files point at the release's binaries", () => {
	const files = packageFiles("1.2.3", sums);
	const formula = files["Formula/envhound.rb"]!;
	for (const [i, n] of NAMES.slice(0, 4).entries()) {
		expect(formula).toContain(
			`url "https://github.com/michelsalib/envhound/releases/download/v1.2.3/${n}"`,
		);
		expect(formula).toContain(`sha256 "${String(i).repeat(64)}"`);
	}
	expect(formula).toContain('version "1.2.3"');
	expect(formula).toContain('chmod 0755, bin/"envhound"');

	const scoop = JSON.parse(files["envhound.json"]!);
	expect(scoop.version).toBe("1.2.3");
	expect(scoop.architecture["64bit"]).toEqual({
		url: "https://github.com/michelsalib/envhound/releases/download/v1.2.3/envhound-windows-x64.exe#/envhound.exe",
		hash: "4".repeat(64),
	});

	const dir = "manifests/m/MichelSalib/envhound/1.2.3";
	expect(Object.keys(files).filter((f) => f.startsWith(dir))).toHaveLength(3);
	expect(files[`${dir}/MichelSalib.envhound.installer.yaml`]).toContain(
		`InstallerSha256: ${"4".repeat(64)}`,
	);
});

test("a binary missing from SHA256SUMS is an error", () =>
	expect(() => packageFiles("1.2.3", sums.split("\n")[0]!)).toThrow(
		"no entry for",
	));
