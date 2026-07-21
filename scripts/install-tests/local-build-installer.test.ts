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

function writeTools(options: { cloneFails?: boolean; curlFails?: boolean; bashFails?: boolean; bun?: "path" | "failing-link" } = {}): void {
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
}

async function run(args: string[], extra: Record<string, string> = {}) {
	const proc = Bun.spawn(["sh", installer, ...args], {
		env: { PATH: `${sandbox.bin}:/usr/bin:/bin`, HOME: sandbox.home, TMPDIR: sandbox.root, TEST_LOG: sandbox.log, BUN_INSTALL: path.join(sandbox.root, "bun home"), ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { exitCode, stdout, stderr };
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
	test("validates option arity, refs, and option-like destinations before filesystem tools", async () => {
		writeTools({ bun: "path" });
		for (const args of [["--ref"], ["--ref", "-branch"], ["--ref", "branch name"], ["--dir", "-destination"]]) {
			const result = await run(args);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("argument parsing");
		}
		const environmentDestination = await run([], { GJC_SRC_DIR: "-environment-destination" });
		expect(environmentDestination.exitCode).not.toBe(0);
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
		let result = await run(["--dir", nonempty]);
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(path.join(nonempty, "keep"), "utf8")).toBe("user data");
		const checkout = path.join(sandbox.root, "checkout");
		fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
		result = await run(["--dir", checkout], { TEST_ORIGIN: "https://example.invalid/other.git" });
		expect(result.stderr).toContain("expected origin");
		result = await run(["--dir", checkout], { TEST_DIRTY: "1" });
		expect(result.stderr).toContain("not clean");
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

	test("restores reused regular and linked worktrees after a link failure", async () => {
		writeTools({ bun: "failing-link" });
		const freshDestination = path.join(sandbox.root, "failed-link");
		let result = await run(["--dir", freshDestination]);
		expect(result.exitCode).not.toBe(0);
		expect(fs.existsSync(freshDestination)).toBe(true);
		expect(temporaryClones()).toEqual([]);
		for (const linked of [false, true]) {
			fs.writeFileSync(sandbox.log, "");
			const checkout = path.join(sandbox.root, linked ? "linked" : "regular");
			fs.mkdirSync(checkout);
			if (linked) fs.writeFileSync(path.join(checkout, ".git"), "gitdir: /elsewhere");
			else fs.mkdirSync(path.join(checkout, ".git"));
			const result = await run(["--dir", checkout], { TEST_HEAD_REF: "refs/heads/main" });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("linking");
			const log = fs.readFileSync(sandbox.log, "utf8");
			expect(log).toContain("<checkout> <--quiet> <refs/heads/main>");
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
