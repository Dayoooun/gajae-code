import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..");
const installer = path.join(repoRoot, "scripts", "install_local_build.sh");

interface Sandbox {
	root: string;
	bin: string;
	log: string;
	home: string;
}

let sandbox: Sandbox;

function writeExecutable(name: string, body: string): void {
	const target = path.join(sandbox.bin, name);
	fs.writeFileSync(target, `#!/bin/sh\nset -eu\n${body}\n`);
	fs.chmodSync(target, 0o755);
}

function writeTools(options: { cloneFails?: boolean; curlFails?: boolean; bashFails?: boolean; bun?: "path" | "failing-link"; tar?: "failing-producer" | "failing-extractor" | "blocking-extractor"; markerWriteFails?: boolean; statusWriteFails?: boolean } = {}): void {
	writeExecutable(
		"git",
		[
			'printf "git" >> "$TEST_LOG"',
			'for argument in "$@"; do printf " <%s>" "$argument" >> "$TEST_LOG"; done',
			'printf "\\n" >> "$TEST_LOG"',
			'if [ "${1:-}" = "clone" ]; then',
			options.cloneFails ? "  exit 42" : '  mkdir -p "$3/.git"; [ -z "${TEST_RACE_DEST:-}" ] || { mkdir "$TEST_RACE_DEST"; printf foreign > "$TEST_RACE_DEST/keep"; }; exit 0',
			"fi",
			'if [ "${3:-}" = "config" ] || [ "${3:-}" = "remote" ]; then printf "%s\\n" "${TEST_ORIGIN:-https://github.com/Yeachan-Heo/gajae-code.git}"; exit 0; fi',
			'if [ "${3:-}" = "status" ]; then [ "${TEST_DIRTY:-}" = "1" ] && printf " M changed\\n"; exit 0; fi',
			'if [ "${3:-}" = "symbolic-ref" ]; then [ -z "${TEST_HEAD_REF+x}" ] || printf "%s\\n" "$TEST_HEAD_REF"; exit 0; fi',
			'if [ "${3:-}" = "rev-parse" ] && [ "${4:-}" = "--is-inside-work-tree" ] && [ "${TEST_NOT_GIT:-}" = "1" ]; then exit 1; fi',
			'if [ "${3:-}" = "rev-parse" ] && [ "${4:-}" = "--show-toplevel" ]; then printf "%s\\n" "${TEST_TOPLEVEL:-$2}"; exit 0; fi',
			'if [ "${3:-}" = "rev-parse" ]; then printf "%040d\\n" 0; exit 0; fi',
			"exit 0",
		].join("\n"),
	);
	writeExecutable("curl", options.curlFails ? "exit 22" : ['out=""; previous=""', 'for argument in "$@"; do [ "$previous" = "-o" ] && out="$argument"; previous="$argument"; done', '[ -n "$out" ]', 'printf "#!/bin/sh\\nexit 0\\n" > "$out"'].join("\n"));
	writeExecutable(
		"bash",
		options.bashFails
			? "exit 9"
			: ['mkdir -p "$BUN_INSTALL/bin"', 'cat > "$BUN_INSTALL/bin/bun" <<\'EOF\'', "#!/bin/sh", 'printf "installed-bun <%s> <%s>\\n" "${1:-}" "${GJC_DEV_LINK_DIR:-}" >> "$TEST_LOG"', '[ "${1:-}" = "--version" ] && echo 1.3.14', "exit 0", "EOF", 'chmod +x "$BUN_INSTALL/bin/bun"'].join("\n"),
	);
	if (options.bun) {
		writeExecutable(
			"bun",
			[
				'printf "path-bun" >> "$TEST_LOG"',
				'for argument in "$@"; do printf " <%s>" "$argument" >> "$TEST_LOG"; done',
				'printf " <link=%s>\\n" "${GJC_DEV_LINK_DIR:-}" >> "$TEST_LOG"',
				'[ "${1:-}" = "--version" ] && echo 1.3.14',
				options.bun === "failing-link" ? '[ "${1:-}" = "run" ] && [ "${2:-}" = "dev:link" ] && exit 9' : "",
				"exit 0",
			].join("\n"),
		);
	}
	if (options.markerWriteFails) {
		writeExecutable(
			"mkdir",
			['if [ "${TEST_MARKER_FAIL_DEST:-}" = "${1:-}" ]; then', '  /bin/mkdir "$@"', '  chmod a-w "$1"', '  exit 0', "fi", 'exec /bin/mkdir "$@"'].join("\n"),
		);
	}
	if (options.statusWriteFails) {
		writeExecutable(
			"mktemp",
			['result=$(/usr/bin/mktemp "$@")', 'case "$result" in *gjc-promotion.*) rmdir "$result" ;; esac', 'printf "%s\\n" "$result"'].join("\n"),
		);
	}
	if (options.tar) {
		writeExecutable(
			"tar",
			[
				options.tar === "failing-producer" ? '[ "${1:-}" = "cf" ] && exit 43' : "",
				options.tar === "failing-extractor" ? '[ "${1:-}" = "xpf" ] && { printf partial > partial-copy; exit 44; }' : "",
				options.tar === "blocking-extractor" ? '[ "${1:-}" = "xpf" ] && { printf partial > partial-copy; : > "$TEST_INTERRUPT_READY"; while [ ! -f "$TEST_INTERRUPT_RELEASE" ]; do sleep 0.01; done; }' : "",
				"exit 0",
			].join("\n"),
		);
	}
}

function start(args: string[], extra: Record<string, string> = {}) {
	return Bun.spawn(["sh", installer, ...args], {
		cwd: repoRoot,
		env: { PATH: `${sandbox.bin}:/usr/bin:/bin`, HOME: sandbox.home, TMPDIR: sandbox.root, TEST_LOG: sandbox.log, BUN_INSTALL: path.join(sandbox.root, "bun home"), ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function run(args: string[], extra: Record<string, string> = {}) {
	const proc = start(args, extra);
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { exitCode, stdout, stderr };
}

async function waitForPath(target: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (fs.existsSync(target)) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${target}`);
}

function temporaryClones(): string[] {
	return fs.readdirSync(sandbox.root).filter((entry) => entry.startsWith(".gajae-code.clone."));
}

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-local-build-"));
	sandbox = { root, bin: path.join(root, "bin"), log: path.join(root, "calls.log"), home: path.join(root, "home") };
	fs.mkdirSync(sandbox.bin);
	fs.mkdirSync(sandbox.home);
	fs.writeFileSync(sandbox.log, "");
});
afterEach(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

describe("install_local_build.sh", () => {
	test("preserves invalid argument failures without cleanup errors", async () => {
		writeTools({ bun: "path" });
		for (const [args, expectedStderr] of [
			[["--ref"], "argument parsing: Option --ref requires a value.\n"],
			[["--ref", "-branch"], "argument parsing: Ref must not be empty, start with '-', or contain whitespace.\n"],
			[["--ref", "branch name"], "argument parsing: Ref must not be empty, start with '-', or contain whitespace.\n"],
			[["--dir", "-destination"], "argument parsing: Destination must not be empty or start with '-'.\n"],
		] as const) {
			const result = await run(args);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe(expectedStderr);
		}
		const environmentDestination = await run([], { GJC_SRC_DIR: "-environment-destination" });
		expect(environmentDestination.exitCode).toBe(1);
		expect(environmentDestination.stderr).toBe("argument parsing: Destination must not be empty or start with '-'.\n");
		expect(fs.readFileSync(sandbox.log, "utf8")).toBe("");
	});

	test("accepts space-containing destinations without splitting paths", async () => {
		writeTools({ bun: "path" });
		const destination = path.join(sandbox.root, "source checkout with spaces");
		const result = await run(["--dir", destination, "--no-link", "--ref", "release/test"]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(fs.existsSync(path.join(destination, ".git"))).toBe(true);
		expect(fs.readFileSync(sandbox.log, "utf8")).not.toContain("dev:link");
	});

	test("refuses nonempty destinations and mismatched or dirty checkouts", async () => {
		writeTools({ bun: "path" });
		const nonempty = path.join(sandbox.root, "nonempty");
		fs.mkdirSync(nonempty);
		fs.writeFileSync(path.join(nonempty, "keep"), "user data");
		let result = await run(["--dir", nonempty], { TEST_NOT_GIT: "1" });
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(path.join(nonempty, "keep"), "utf8")).toBe("user data");
		const checkout = path.join(sandbox.root, "checkout");
		fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
		result = await run(["--dir", checkout], { TEST_ORIGIN: "https://example.invalid/other.git" });
		expect(result.stderr).toContain("expected origin");
		result = await run(["--dir", checkout], { TEST_DIRTY: "1" });
		expect(result.stderr).toContain("not clean");
	});
	test("refuses a nested directory of an otherwise valid checkout", async () => {
		writeTools({ bun: "path" });
		const checkout = path.join(sandbox.root, "checkout");
		const nested = path.join(checkout, "nested");
		fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
		const result = await run(["--dir", nested], { TEST_TOPLEVEL: checkout });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("checkout root");
		expect(fs.readFileSync(sandbox.log, "utf8")).not.toContain("<fetch>");
	});

	test("preserves a concurrent foreign destination and deletes only the temporary clone", async () => {
		writeTools({ bun: "path" });
		const destination = path.join(sandbox.root, "destination");
		const result = await run(["--dir", destination], { TEST_RACE_DEST: destination });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Destination appeared");
		expect(fs.readFileSync(path.join(destination, "keep"), "utf8")).toBe("foreign");
		expect(fs.readdirSync(destination)).toEqual(["keep"]);
		expect(temporaryClones()).toEqual([]);
	});
	test("rolls back an ownership-proven destination claim after a tar producer failure", async () => {
		writeTools({ bun: "path", tar: "failing-producer" });
		const destination = path.join(sandbox.root, "failed-producer");
		const result = await run(["--dir", destination]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Could not populate");
		expect(fs.existsSync(destination)).toBe(false);
		expect(temporaryClones()).toEqual([]);
	});
	test("rolls back an ownership-proven destination claim after a tar extractor failure", async () => {
		writeTools({ bun: "path", tar: "failing-extractor" });
		const destination = path.join(sandbox.root, "failed-extractor");
		const result = await run(["--dir", destination]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Could not populate");
		expect(fs.existsSync(destination)).toBe(false);
		expect(temporaryClones()).toEqual([]);
	});
	test("rolls back an empty destination claim when ownership-marker creation fails", async () => {
		writeTools({ bun: "path", markerWriteFails: true });
		const destination = path.join(sandbox.root, "failed-marker");
		const result = await run(["--dir", destination], { TEST_MARKER_FAIL_DEST: destination });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Could not mark");
		expect(fs.existsSync(destination)).toBe(false);
		expect(temporaryClones()).toEqual([]);
	});
	test("rolls back a marker-proven destination claim when copy-status bookkeeping fails", async () => {
		writeTools({ bun: "path", statusWriteFails: true });
		const destination = path.join(sandbox.root, "failed-status-bookkeeping");
		const result = await run(["--dir", destination]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Could not populate");
		expect(fs.existsSync(destination)).toBe(false);
		expect(temporaryClones()).toEqual([]);
	});
	test("rolls back a marker-proven claim below a newline-containing parent", async () => {
		writeTools({ bun: "path", tar: "failing-producer" });
		const parent = path.join(sandbox.root, "newline\nparent");
		const destination = path.join(parent, "failed-promotion");
		const result = await run(["--dir", destination]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Could not populate");
		expect(fs.existsSync(destination)).toBe(false);
		expect(temporaryClones()).toEqual([]);
	});
	test("signal cleanup removes owned partial promotions and preserves foreign destinations", async () => {
		writeTools({ bun: "path", tar: "blocking-extractor" });
		for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
			for (const foreign of [false, true]) {
				const destination = path.join(sandbox.root, `${signal}-${foreign ? "foreign" : "owned"}`);
				const ready = path.join(sandbox.root, `${signal}-${foreign ? "foreign" : "owned"}.ready`);
				const release = path.join(sandbox.root, `${signal}-${foreign ? "foreign" : "owned"}.release`);
				const proc = start(["--dir", destination], { TEST_INTERRUPT_READY: ready, TEST_INTERRUPT_RELEASE: release });
				const stdout = new Response(proc.stdout).text();
				const stderr = new Response(proc.stderr).text();
				await waitForPath(ready);
				expect(fs.existsSync(path.join(destination, "partial-copy"))).toBe(true);
				if (foreign) {
					fs.rmSync(destination, { recursive: true, force: true });
					fs.mkdirSync(destination);
					fs.writeFileSync(path.join(destination, "keep"), "foreign");
					fs.writeFileSync(path.join(destination, ".gajae-code-install-owner"), "foreign-token\n");
				}
				proc.kill(signal);
				fs.writeFileSync(release, "");
				const [resultStdout, resultStderr, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
				expect(exitCode, `${resultStdout}\n${resultStderr}`).not.toBe(0);
				if (foreign) {
					expect(fs.readFileSync(path.join(destination, "keep"), "utf8")).toBe("foreign");
				} else {
					expect(fs.existsSync(destination)).toBe(false);
				}
			}
		}
	});
	test("cleans an invocation-owned partial clone after clone failure", async () => {
		writeTools({ cloneFails: true, bun: "path" });
		const result = await run(["--dir", path.join(sandbox.root, "destination")]);
		expect(result.exitCode).not.toBe(0);
		expect(temporaryClones()).toEqual([]);
	});

	test("reports Bun download and installer failures without removing a promoted destination", async () => {
		const destination = path.join(sandbox.root, "destination");
		writeTools({ curlFails: true });
		let result = await run(["--dir", destination]);
		expect(result.stderr).toContain("Bun download");
		expect(fs.existsSync(destination)).toBe(true);
		writeTools({ bashFails: true });
		result = await run(["--dir", path.join(sandbox.root, "second destination")]);
		expect(result.stderr).toContain("Bun installation");
		expect(temporaryClones()).toEqual([]);
	});

	test("uses the default link, passes GJC_DEV_LINK_DIR, and honors --no-link", async () => {
		writeTools({ bun: "path" });
		const destination = path.join(sandbox.root, "destination");
		let result = await run(["--dir", destination], { GJC_DEV_LINK_DIR: path.join(sandbox.root, "links") });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		let log = fs.readFileSync(sandbox.log, "utf8");
		expect(log).toContain(`path-bun <run> <dev:link> <link=${path.join(sandbox.root, "links")}>`);
		fs.writeFileSync(sandbox.log, "");
		result = await run(["--dir", path.join(sandbox.root, "no-link"), "--no-link"]);
		expect(result.exitCode).toBe(0);
		log = fs.readFileSync(sandbox.log, "utf8");
		expect(log).not.toContain("dev:link");
	});

	test("restores relative regular and linked worktrees after a link failure", async () => {
		writeTools({ bun: "failing-link" });
		const freshDestination = path.join(sandbox.root, "failed-link");
		let result = await run(["--dir", freshDestination]);
		expect(result.exitCode).not.toBe(0);
		expect(fs.existsSync(freshDestination)).toBe(true);
		expect(temporaryClones()).toEqual([]);
		for (const { linked, headRef } of [
			{ linked: false, headRef: "refs/heads/main" },
			{ linked: true, headRef: undefined },
		]) {
			fs.writeFileSync(sandbox.log, "");
			const checkout = path.join(sandbox.root, linked ? "linked" : "regular");
			fs.mkdirSync(checkout);
			if (linked) fs.writeFileSync(path.join(checkout, ".git"), "gitdir: /elsewhere");
			else fs.mkdirSync(path.join(checkout, ".git"));
			const relativeCheckout = path.relative(repoRoot, checkout);
			result = await run(["--dir", relativeCheckout], headRef ? { TEST_HEAD_REF: headRef } : {});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("linking");
			const log = fs.readFileSync(sandbox.log, "utf8");
			if (headRef) {
				expect(log).toContain(`git <-C> <${checkout}> <checkout> <--quiet> <${headRef}>`);
			} else {
				expect(log).toContain(`git <-C> <${checkout}> <checkout> <--quiet> <--detach> <${"0".repeat(40)}>`);
			}
			expect(temporaryClones()).toEqual([]);
		}
	});

	test("uses a PATH Bun instead of an off-PATH BUN_INSTALL candidate", async () => {
		writeTools({ bun: "path" });
		const installedBin = path.join(sandbox.root, "bun home", "bin");
		fs.mkdirSync(installedBin, { recursive: true });
		fs.writeFileSync(path.join(installedBin, "bun"), "#!/bin/sh\nprintf 'off-path-bun\\n' >> \"$TEST_LOG\"\nexit 99\n", { mode: 0o755 });
		const result = await run(["--dir", path.join(sandbox.root, "destination"), "--no-link"]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		const log = fs.readFileSync(sandbox.log, "utf8");
		expect(log).toContain("path-bun <install>");
		expect(log).not.toContain("off-path-bun");
	});
});
