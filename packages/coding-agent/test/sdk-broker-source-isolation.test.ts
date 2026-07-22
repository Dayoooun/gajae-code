import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { type FixtureBrokerLease, startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";

const roots = new Set<string>();
const brokerLeases = new Map<string, FixtureBrokerLease>();
const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-isolation-"));
	roots.add(root);
	return root;
}

afterEach(async () => {
	for (const root of roots) {
		await brokerLeases.get(root)?.close();
		await fs.rm(root, { recursive: true, force: true });
	}
	roots.clear();
	brokerLeases.clear();
});

it("keeps detached source brokers isolated from hostile workspace configuration", async () => {
	const root = await tempRoot();
	const hostileCwd = path.join(root, "hostile project ü");
	const agentDir = path.join(root, "agent");
	const preloadSentinel = path.join(root, "preload-sentinel");
	const dotenvSentinel = path.join(root, "dotenv-sentinel");
	const preload = path.join(root, "preload.ts");
	const pathSentinel = path.join(root, "path-sentinel");
	const hostileBin = path.join(root, "hostile-bin");
	const xdgDataHome = path.join(root, "data");
	const nativeCacheDir = path.join(xdgDataHome, "gjc", "natives", "0.11.6");
	await fs.mkdir(hostileCwd, { recursive: true });
	await fs.mkdir(hostileBin, { recursive: true });
	const fakeBun = path.join(hostileBin, process.platform === "win32" ? "bun.cmd" : "bun");
	await fs.mkdir(path.join(xdgDataHome, "gjc"), { recursive: true });
	await Bun.write(
		fakeBun,
		process.platform === "win32"
			? `@echo path-hijack>${JSON.stringify(pathSentinel)}\r\n`
			: `#!/bin/sh\nprintf path-hijack > ${JSON.stringify(pathSentinel)}\n`,
	);
	if (process.platform !== "win32") await fs.chmod(fakeBun, 0o755);
	await fs.mkdir(agentDir, { recursive: true });
	brokerLeases.set(
		root,
		(
			await startFixtureBrokerWithLeaseForTest({
				agentDir,
				env: {
					...process.env,
					BUN_OPTIONS: "--no-env-file --config=/dev/null",
					PI_COMPILED: "1",
					GJC_COMPILED: "1",
					PATH: `${hostileBin}${path.delimiter}${process.env.PATH ?? ""}`,
					XDG_DATA_HOME: xdgDataHome,
				},
			})
		).lease,
	);
	await expect(fs.readdir(nativeCacheDir)).rejects.toMatchObject({ code: "ENOENT" });
	await Bun.write(path.join(hostileCwd, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
	await Bun.write(path.join(hostileCwd, ".env"), "GJC_2178_DOTENV=dotenv-loaded\n");
	await Bun.write(
		preload,
		[
			`await Bun.write(${JSON.stringify(preloadSentinel)}, "preload-loaded");`,
			`if (process.env.GJC_2178_DOTENV) await Bun.write(${JSON.stringify(dotenvSentinel)}, process.env.GJC_2178_DOTENV);`,
		].join("\n"),
	);

	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"--config=/dev/null",
			cliEntrypoint,
			"daemon",
			"session",
			"global",
			"--op=session.list",
			"--json-input={}",
			`--agent-dir=${agentDir}`,
		],
		{
			cwd: hostileCwd,
			env: {
				...process.env,
				BUN_OPTIONS: "--no-env-file --config=/dev/null",
				PI_COMPILED: "1",
				GJC_COMPILED: "1",
				PATH: `${hostileBin}${path.delimiter}${process.env.PATH ?? ""}`,
				XDG_DATA_HOME: xdgDataHome,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	const response = JSON.parse(stdout.trim()) as { ok?: boolean; result?: { sessions?: unknown[] } };
	expect(response.ok).toBe(true);
	expect(response.result?.sessions).toEqual([]);
	expect(await readBrokerDiscovery(agentDir)).not.toBeNull();
	expect(brokerLeases.get(root)).toBeDefined();
	expect(await Bun.file(preloadSentinel).exists()).toBe(false);
	expect(await Bun.file(dotenvSentinel).exists()).toBe(false);
	expect(await Bun.file(pathSentinel).exists()).toBe(false);
});

it("starts the default source session host without loading hostile workspace bunfig, dotenv, or preload configuration while independently reporting its workspace cwd", async () => {
	const root = await tempRoot();
	const workspace = path.join(root, "workspace ü");
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(workspace, ".gjc", "state");
	const preloadSentinel = path.join(root, "host-preload-sentinel");
	const dotenvSentinel = path.join(root, "host-dotenv-sentinel");
	const preload = path.join(root, "host-preload.ts");
	await fs.mkdir(workspace, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(workspace, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
	await Bun.write(path.join(workspace, ".env"), "GJC_2178_HOST_DOTENV=dotenv-loaded\n");
	await Bun.write(
		preload,
		[
			`await Bun.write(${JSON.stringify(preloadSentinel)}, process.cwd());`,
			`if (process.env.GJC_2178_HOST_DOTENV) await Bun.write(${JSON.stringify(dotenvSentinel)}, process.env.GJC_2178_HOST_DOTENV);`,
		].join("\n"),
	);
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	delete process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		const created = await broker.handleRequest(
			"session.create",
			{ cwd: workspace, stateRoot, readinessTimeoutMs: 10_000 },
			"source-host-isolation",
		);
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error(created.error.message);
		const sessionId = (created.result as { sessionId?: unknown }).sessionId;
		expect(typeof sessionId).toBe("string");
		if (typeof sessionId !== "string") throw new Error("session.create did not return a session id");
		expect(created.result).toMatchObject({ cwd: workspace });
		expect(await Bun.file(preloadSentinel).exists()).toBe(false);
		expect(await Bun.file(dotenvSentinel).exists()).toBe(false);
		expect(await broker.handleRequest("session.close", { sessionId }, "source-host-close")).toMatchObject({
			ok: true,
			result: { sessionId },
		});
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
	}
}, 30_000);
