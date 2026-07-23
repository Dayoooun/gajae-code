import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import {
	DAEMON_GENERATION,
	DAEMON_VERSION,
	daemonPaths,
	ensureTelegramDaemonRunningDetailed,
	reapNotificationArtifacts,
	renewDaemonHeartbeat,
	TelegramNotificationDaemon,
	type DaemonState,
	type TelegramDaemonFs,
} from "../src/sdk/bus/telegram-daemon";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-daemon-redteam-"));
}

function settings(agentDir: string): Settings {
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(isolated, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function daemonFs(readdirOverride?: (dir: string) => Promise<string[]>): TelegramDaemonFs {
	return {
		...(fs.promises as unknown as TelegramDaemonFs),
		mkdir: (file, opts) => fs.promises.mkdir(file, opts).then(() => undefined),
		readFile: (file, encoding) => fs.promises.readFile(file, encoding),
		writeFile: (file, data, opts) => fs.promises.writeFile(file, data, opts).then(() => undefined),
		rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath).then(() => undefined),
		unlink: file => fs.promises.unlink(file),
		open: async (file, flags, mode) => fs.promises.open(file, flags, mode),
		readdir: readdirOverride ?? (file => fs.promises.readdir(file)),
		chmod: (file, mode) => fs.promises.chmod(file, mode),
		stat: file => fs.promises.stat(file),
		readEndpointFile: async file => {
			const bytes = await fs.promises.readFile(file);
			const stat = await fs.promises.lstat(file, { bigint: true });
			return { bytes, identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
		},
		exactUnlink: async (file, identity) => {
			const bytes = await fs.promises.readFile(file).catch(() => undefined);
			if (!bytes) return { ok: false, code: "missing" };
			const stat = await fs.promises.lstat(file, { bigint: true });
			const matches = stat.dev === identity.dev && stat.ino === identity.ino && stat.size === identity.size && stat.mtimeNs === identity.mtimeNs && crypto.createHash("sha256").update(bytes).digest("hex") === identity.sha256;
			if (!matches) return { ok: false, code: "identity_mismatch" };
			await fs.promises.unlink(file);
			return { ok: true };
		},
	};
}

function writeRoots(agentDir: string, state: { roots: string[]; managedRoots?: string[]; sessions?: Record<string, string> }): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.roots, JSON.stringify({ version: 1, roots: state.roots, managedRoots: state.managedRoots ?? state.roots, sessions: state.sessions ?? {} }));
}

function writeLiveOwner(agentDir: string, state: DaemonState): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.state, JSON.stringify(state));
	fs.writeFileSync(paths.lock, JSON.stringify({ pid: state.pid, incarnation: state.incarnation, ownerId: state.ownerId, acquisitionId: state.acquisitionId ?? state.ownerId, startedAt: state.startedAt }));
}

function writeTopicState(agentDir: string): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(path.join(paths.dir, "telegram-topics.json"), JSON.stringify({ topics: { orphan: { topicId: "101", identitySent: true, createdAt: 0, name: "orphan", chatId: "42", endpointKey: "ws://orphan", endpointDigest: "orphan", endpointGeneration: 1 } } }));
}

function botApi() { return { call: async () => ({ ok: true }) }; }

function oldOwner(now: number): DaemonState {
	return { pid: 999, incarnation: "linux:100", ownerId: "old-owner", acquisitionId: "old-owner", ownershipPhase: "ready", tokenFingerprint: tokenFingerprint("123456:secret-token"), chatId: "42", startedAt: now, heartbeatAt: now, roots: [], version: DAEMON_VERSION, generation: DAEMON_GENERATION - 1 };
}

test("artifact reaping preserves young/non-matching files, honors exact limit, and tolerates unavailable/racing fs", async () => {
	const dir = tempDir();
	const now = 1_000_000;
	const stale = [".gjc-delete-daemon-transition-a.json", ".gjc-exact-unlink-placeholder-b", ".gjc-delete-notification-endpoint-c.json"];
	for (const name of stale) {
		const file = path.join(dir, name);
		fs.writeFileSync(file, "old");
		fs.utimesSync(file, new Date(now - 120_000), new Date(now - 120_000));
	}
	const young = path.join(dir, ".gjc-delete-daemon-transition-young.json");
	const unrelated = path.join(dir, ".gjc-unrelated.json");
	fs.writeFileSync(young, "young"); fs.writeFileSync(unrelated, "unrelated");
	fs.utimesSync(young, new Date(now), new Date(now)); fs.utimesSync(unrelated, new Date(now - 120_000), new Date(now - 120_000));
	expect(await reapNotificationArtifacts({ dir, fs: daemonFs(), now: () => now, graceMs: 60_000, limit: 2 })).toBe(2);
	expect(stale.filter(name => fs.existsSync(path.join(dir, name)))).toHaveLength(1);
	expect(fs.existsSync(young)).toBe(true); expect(fs.existsSync(unrelated)).toBe(true);
	expect(await reapNotificationArtifacts({ dir, fs: { ...daemonFs(), stat: undefined }, now: () => now })).toBe(0);
	expect(await reapNotificationArtifacts({ dir, fs: daemonFs(async () => { throw new Error("read failure"); }), now: () => now })).toBe(0);
	const race = path.join(dir, ".gjc-delete-daemon-transition-race.json");
	fs.writeFileSync(race, "race"); fs.utimesSync(race, new Date(now - 120_000), new Date(now - 120_000));
	const racingFs = { ...daemonFs(), unlink: async (file: string) => { await fs.promises.unlink(file); const error = new Error("raced") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; } };
	await expect(reapNotificationArtifacts({ dir, fs: racingFs, now: () => now, graceMs: 60_000 })).resolves.toBeGreaterThanOrEqual(0);
});

test("scanRoots prunes dead legacy roots and their session registrations without leaving dangling references", async () => {
	const agentDir = tempDir(); const live = path.join(agentDir, "live"); const legacyDead = path.join(agentDir, "legacy-dead");
	fs.mkdirSync(path.join(live, "sdk"), { recursive: true });
	writeRoots(agentDir, { roots: [legacyDead, live], managedRoots: [live], sessions: { legacySession: legacyDead } });
	const daemon = new TelegramNotificationDaemon({ settings: settings(agentDir), ownerId: "owner", botToken: "tok", chatId: "42", botApi: botApi(), fs: daemonFs() });
	await daemon.scanRoots();
	expect(JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8"))).toEqual({ version: 1, roots: [live], managedRoots: [live], sessions: {} });
});

test("scanRoots prunes only ENOENT roots and suppresses reconciliation while another root is transiently unreadable", async () => {
	const agentDir = tempDir(); const live = path.join(agentDir, "live"); const dead = path.join(agentDir, "dead"); const transient = path.join(agentDir, "transient");
	fs.mkdirSync(path.join(live, "sdk"), { recursive: true }); fs.mkdirSync(path.join(transient, "sdk"), { recursive: true });
	writeRoots(agentDir, { roots: [dead, live, transient], sessions: { dead: dead, transient: transient } });
	writeTopicState(agentDir);
	const daemon = new TelegramNotificationDaemon({ settings: settings(agentDir), ownerId: "owner", botToken: "tok", chatId: "42", botApi: botApi(), fs: daemonFs(async dir => { if (dir === path.join(transient, "sdk")) { const error = new Error("busy") as NodeJS.ErrnoException; error.code = "EACCES"; throw error; } return fs.promises.readdir(dir); }) });
	await daemon.loadTopics();
	await daemon.scanRoots();
	const roots = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8"));
	expect(roots).toEqual({ version: 1, roots: [live, transient], managedRoots: [live, transient], sessions: { transient } });
	expect(JSON.parse(fs.readFileSync(path.join(daemonPaths(agentDir).dir, "telegram-topics.json"), "utf8")).topics.orphan.orphanedAt).toBeUndefined();
});

async function ensureCooldownCase(mode: "dead-within-window" | "live-after-window"): Promise<void> {
	const agentDir = tempDir(); const s = settings(agentDir); let now = 1_000; const alive = new Set<number>([999, 4242]); let spawns = 0; let pending: { ownerId: string; pid: number } | undefined; let reloadPid = 999;
	writeLiveOwner(agentDir, oldOwner(now));
	const deps = {
		fs: daemonFs(), pid: 4242, now: () => now, pidAlive: (pid: number) => alive.has(pid), pidIncarnation: () => "linux:100", waitStepMs: 1, readinessTimeoutMs: 10,
		processReference: (pid: number) => pid === reloadPid ? { incarnation: "linux:100", termination: "cooperative" as const, signalRoot: (signal: NodeJS.Signals) => { if (signal === "SIGTERM") alive.delete(pid); } } : undefined,
		spawn: (_command: string, args: string[]) => { const pid = 5000 + ++spawns; pending = { ownerId: args[args.indexOf("--owner-id") + 1]!, pid }; alive.add(pid); return { pid, unref() {} }; },
		sleep: async () => { if (pending) await renewDaemonHeartbeat({ settings: s, ownerId: pending.ownerId, acquisitionId: pending.ownerId, pid: pending.pid, pidIncarnation: () => "linux:100", now: () => now, fs: daemonFs() }); },
	};
	expect(await ensureTelegramDaemonRunningDetailed({ settings: s, cwd: path.join(agentDir, "one"), sessionId: "one" }, deps)).toBe("reloaded");
	const current = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as DaemonState;
	current.generation = DAEMON_GENERATION - 1;
	const retry = mode === "dead-within-window" ? current : (now += 600_001, oldOwner(now));
	if (mode === "dead-within-window") alive.delete(retry.pid);
	else { reloadPid = retry.pid; alive.add(retry.pid); }
	writeLiveOwner(agentDir, retry);
	expect(await ensureTelegramDaemonRunningDetailed({ settings: s, cwd: path.join(agentDir, "two"), sessionId: "two" }, deps)).toBe(mode === "dead-within-window" ? "spawned" : "reloaded");
	expect(spawns).toBe(2);
}

test("reload cooldown does not suppress dead-owner recovery", async () => { await ensureCooldownCase("dead-within-window"); });
test("reload cooldown permits a fresh live generation reload after ten minutes", async () => { await ensureCooldownCase("live-after-window"); });
