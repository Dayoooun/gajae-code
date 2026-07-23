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
	reloadReservationLockOptions,
	renewDaemonHeartbeat,
	TelegramNotificationDaemon,
	type DaemonState,
	type TelegramDaemonFs,
} from "../src/sdk/bus/telegram-daemon";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-daemon-2956-"));
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
			return {
				bytes,
				identity: {
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
				},
			};
		},
		exactUnlink: async (file, identity) => {
			const bytes = await fs.promises.readFile(file).catch(() => undefined);
			if (!bytes) return { ok: false, code: "missing" };
			const stat = await fs.promises.lstat(file, { bigint: true });
			const matches =
				stat.dev === identity.dev &&
				stat.ino === identity.ino &&
				stat.size === identity.size &&
				stat.mtimeNs === identity.mtimeNs &&
				crypto.createHash("sha256").update(bytes).digest("hex") === identity.sha256;
			if (!matches) return { ok: false, code: "identity_mismatch" };
			await fs.promises.unlink(file);
			return { ok: true };
		},
	};
}

function writeTopicState(agentDir: string, sessionId = "orphan"): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(
		path.join(paths.dir, "telegram-topics.json"),
		JSON.stringify({
			topics: {
				[sessionId]: {
					topicId: "101",
					identitySent: true,
					createdAt: 0,
					name: sessionId,
					chatId: "42",
					endpointKey: "ws://orphan",
					endpointDigest: "orphan-digest",
					endpointGeneration: 1,
				},
			},
		}),
	);
}

function writeRoots(
	agentDir: string,
	state: { roots: string[]; managedRoots?: string[]; sessions?: Record<string, string> },
): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(
		paths.roots,
		JSON.stringify({
			version: 1,
			roots: state.roots,
			managedRoots: state.managedRoots ?? state.roots,
			sessions: state.sessions ?? {},
		}),
	);
}

function botApi() {
	return { call: async () => ({ ok: true }) };
}

test("scanRoots prunes ENOENT roots and still reconciles orphan topics", async () => {
	const agentDir = tempDir();
	const liveRoot = path.join(agentDir, "live-root");
	const deadRoot = path.join(agentDir, "dead-root");
	fs.mkdirSync(path.join(liveRoot, "sdk"), { recursive: true });
	const s = settings(agentDir);
	writeRoots(agentDir, {
		roots: [deadRoot, liveRoot],
		managedRoots: [deadRoot, liveRoot],
		sessions: { deadSession: deadRoot },
	});
	writeTopicState(agentDir);
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: botApi(),
		fs: daemonFs(),
		now: () => 1_000,
	});

	await daemon.loadTopics();
	await daemon.scanRoots();

	const roots = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as {
		version: number;
		roots: string[];
		managedRoots: string[];
		sessions: Record<string, string>;
	};
	expect(roots).toEqual({ version: 1, roots: [liveRoot], managedRoots: [liveRoot], sessions: {} });
	const topics = JSON.parse(
		fs.readFileSync(path.join(daemonPaths(agentDir).dir, "telegram-topics.json"), "utf8"),
	) as { topics: Record<string, { orphanedAt?: number }> };
	expect(topics.topics.orphan.orphanedAt).toBe(1_000);
});

test("scanRoots retains transiently unreadable roots and suppresses orphan reconciliation", async () => {
	const agentDir = tempDir();
	const liveRoot = path.join(agentDir, "live-root");
	const transientRoot = path.join(agentDir, "transient-root");
	fs.mkdirSync(path.join(liveRoot, "sdk"), { recursive: true });
	fs.mkdirSync(path.join(transientRoot, "sdk"), { recursive: true });
	const transientSdk = path.join(transientRoot, "sdk");
	const s = settings(agentDir);
	writeRoots(agentDir, {
		roots: [liveRoot, transientRoot],
		managedRoots: [liveRoot, transientRoot],
		sessions: { transientSession: transientRoot },
	});
	writeTopicState(agentDir);
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: botApi(),
		fs: daemonFs(async dir => {
			if (dir === transientSdk) {
				const error = new Error("permission denied") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return fs.promises.readdir(dir);
		}),
		now: () => 1_000,
	});

	await daemon.loadTopics();
	await daemon.scanRoots();

	const roots = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as {
		roots: string[];
		sessions: Record<string, string>;
	};
	expect(roots.roots).toEqual([liveRoot, transientRoot]);
	expect(roots.sessions).toEqual({ transientSession: transientRoot });
	const topics = JSON.parse(
		fs.readFileSync(path.join(daemonPaths(agentDir).dir, "telegram-topics.json"), "utf8"),
	) as { topics: Record<string, { orphanedAt?: number }> };
	expect(topics.topics.orphan.orphanedAt).toBeUndefined();
});

test("reapNotificationArtifacts removes only stale matching artifacts and honors the limit", async () => {
	const dir = tempDir();
	const now = 1_000_000;
	const oldNames = [
		".gjc-delete-daemon-transition-old.json",
		".gjc-exact-unlink-placeholder-old",
		".gjc-delete-notification-endpoint-old.json",
	];
	for (const name of oldNames) {
		const file = path.join(dir, name);
		fs.writeFileSync(file, "old");
		fs.utimesSync(file, new Date(now - 120_000), new Date(now - 120_000));
	}
	const young = path.join(dir, ".gjc-delete-daemon-transition-young.json");
	fs.writeFileSync(young, "young");
	fs.utimesSync(young, new Date(now), new Date(now));
	const nonMatching = path.join(dir, ".gjc-other-old.json");
	fs.writeFileSync(nonMatching, "other");
	fs.utimesSync(nonMatching, new Date(now - 120_000), new Date(now - 120_000));

	expect(
		await reapNotificationArtifacts({ dir, fs: daemonFs(), now: () => now, graceMs: 60_000, limit: 2 }),
	).toBe(2);
	expect(oldNames.filter(name => fs.existsSync(path.join(dir, name)))).toHaveLength(1);
	expect(fs.existsSync(young)).toBe(true);
	expect(fs.existsSync(nonMatching)).toBe(true);
	expect(await reapNotificationArtifacts({ dir, fs: daemonFs(), now: () => now, graceMs: 60_000 })).toBe(1);
	expect(oldNames.some(name => fs.existsSync(path.join(dir, name)))).toBe(false);
});

function writeLiveOwner(agentDir: string, state: DaemonState): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.state, JSON.stringify(state));
	fs.writeFileSync(
		paths.lock,
		JSON.stringify({
			pid: state.pid,
			incarnation: state.incarnation,
			ownerId: state.ownerId,
			acquisitionId: state.acquisitionId ?? state.ownerId,
			startedAt: state.startedAt,
		}),
	);
}

test("ensure cooldown preserves the first reload and attaches on the second automatic attempt", async () => {
	const agentDir = tempDir();
	const s = settings(agentDir);
	const now = 1_000;
	const alive = new Set<number>([999, 4242]);
	const signals: Array<[number, NodeJS.Signals]> = [];
	let spawns = 0;
	let pending: { ownerId: string; pid: number } | undefined;
	const fsImpl = daemonFs();
	const initial: DaemonState = {
		pid: 999,
		incarnation: "linux:100",
		ownerId: "old-owner",
		tokenFingerprint: tokenFingerprint("123456:secret-token"),
		chatId: "42",
		startedAt: now,
		heartbeatAt: now,
		roots: [],
		version: DAEMON_VERSION,
		generation: DAEMON_GENERATION - 1,
		acquisitionId: "old-owner",
		ownershipPhase: "ready",
	};
	writeLiveOwner(agentDir, initial);
	fs.writeFileSync(
		path.join(daemonPaths(agentDir).dir, "telegram-daemon.reload-attempt.json"),
		JSON.stringify({ lastReloadAt: now, ownerId: "old-owner", targetGeneration: DAEMON_GENERATION - 1 }),
	);
	const deps = {
		fs: fsImpl,
		pid: 4242,
		now: () => now,
		pidAlive: (pid: number) => alive.has(pid),
		pidIncarnation: () => "linux:100",
		processReference: (pid: number) =>
			pid === 999
				? {
					incarnation: "linux:100",
					termination: "cooperative" as const,
					signalRoot: (signal: NodeJS.Signals) => {
						signals.push([pid, signal]);
						if (signal === "SIGTERM") alive.delete(pid);
					},
				}
				: undefined,
		spawn: (_command: string, args: string[]) => {
			spawns++;
			const ownerId = args[args.indexOf("--owner-id") + 1]!;
			const pid = 4244;
			pending = { ownerId, pid };
			alive.add(pid);
			return { pid, unref() {} };
		},
		sleep: async () => {
			if (!pending) return;
			await renewDaemonHeartbeat({
				settings: s,
				ownerId: pending.ownerId,
				acquisitionId: pending.ownerId,
				pid: pending.pid,
				pidIncarnation: () => "linux:100",
				now: () => now,
				fs: fsImpl,
			});
		},
		waitStepMs: 1,
		readinessTimeoutMs: 10,
	};

	const firstResult = await ensureTelegramDaemonRunningDetailed(
		{ settings: s, cwd: path.join(agentDir, "first-session"), sessionId: "first-session" },
		deps,
	);
	expect(firstResult).toBe("reloaded");
	expect(spawns).toBe(1);
	expect(signals).toContainEqual([999, "SIGTERM"]);

	const current = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as DaemonState;
	current.generation = DAEMON_GENERATION - 1;
	current.heartbeatAt = now;
	fs.writeFileSync(daemonPaths(agentDir).state, JSON.stringify(current));
	const attempt = JSON.parse(
		fs.readFileSync(path.join(daemonPaths(agentDir).dir, "telegram-daemon.reload-attempt.json"), "utf8"),
	) as { lastReloadAt: number; ownerId: string; targetGeneration: number };
	expect(attempt).toMatchObject({ lastReloadAt: now, ownerId: "old-owner", targetGeneration: DAEMON_GENERATION });

	expect(
		await ensureTelegramDaemonRunningDetailed(
			{ settings: s, cwd: path.join(agentDir, "second-session"), sessionId: "second-session" },
			deps,
		),
	).toBe("attached");
	expect(spawns).toBe(1);
	expect(signals).toHaveLength(1);
});

test("scanRoots retains a registered root until its sdk directory is published", async () => {
	const agentDir = tempDir();
	const root = path.join(agentDir, "starting-root");
	fs.mkdirSync(root, { recursive: true });
	writeRoots(agentDir, { roots: [root], sessions: { starting: root } });
	writeTopicState(agentDir);
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: botApi(),
		fs: daemonFs(),
		now: () => 1_000,
	});
	await daemon.loadTopics();
	await daemon.scanRoots();
	expect(JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8"))).toMatchObject({
		roots: [root],
		sessions: { starting: root },
	});
	expect(
		JSON.parse(fs.readFileSync(path.join(daemonPaths(agentDir).dir, "telegram-topics.json"), "utf8")).topics.orphan
			.orphanedAt,
	).toBe(1_000);
});

test("scanRoots revalidates a dead root before pruning it", async () => {
	const agentDir = tempDir();
	const root = path.join(agentDir, "reregistered-root");
	const sdk = path.join(root, "sdk");
	writeRoots(agentDir, { roots: [root], sessions: { reregistered: root } });
	const fsImpl = daemonFs(async dir => {
		if (dir === sdk) {
			const error = new Error("missing sdk") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		return fs.promises.readdir(dir);
	});
	const stat = fsImpl.stat!;
	let rootStats = 0;
	fsImpl.stat = async file => {
		if (file !== root) return await stat(file);
		rootStats++;
		if (rootStats === 1) {
			const error = new Error("missing root") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		fs.mkdirSync(root, { recursive: true });
		return await stat(file);
	};
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir), ownerId: "owner", botToken: "tok", chatId: "42", botApi: botApi(), fs: fsImpl,
	});
	await daemon.scanRoots();
	expect(JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8"))).toMatchObject({
		roots: [root],
		sessions: { reregistered: root },
	});
});

test("periodic artifact reaping includes registered endpoint directories within the shared budget", async () => {
	const agentDir = tempDir();
	const root = path.join(agentDir, "root");
	const sdk = path.join(root, "sdk");
	const notificationDir = daemonPaths(agentDir).dir;
	fs.mkdirSync(sdk, { recursive: true });
	fs.mkdirSync(notificationDir, { recursive: true });
	writeRoots(agentDir, { roots: [root] });
	const now = 1_000_000;
	const endpointArtifact = path.join(sdk, ".gjc-delete-notification-endpoint-stale.json");
	fs.writeFileSync(endpointArtifact, "stale");
	fs.utimesSync(endpointArtifact, new Date(now - 720_000), new Date(now - 720_000));
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir), ownerId: "owner", botToken: "tok", chatId: "42", botApi: botApi(), fs: daemonFs(), now: () => now,
	});
	await (daemon as unknown as { reapArtifactsIfDue(): Promise<void> }).reapArtifactsIfDue();
	expect(fs.existsSync(endpointArtifact)).toBe(false);
	for (let index = 0; index < 500; index++) {
		const artifact = path.join(notificationDir, `.gjc-exact-unlink-placeholder-${index}`);
		fs.writeFileSync(artifact, "stale");
		fs.utimesSync(artifact, new Date(now - 720_000), new Date(now - 720_000));
	}
	fs.writeFileSync(endpointArtifact, "stale");
	fs.utimesSync(endpointArtifact, new Date(now - 720_000), new Date(now - 720_000));
	(daemon as unknown as { lastArtifactReapAt: number }).lastArtifactReapAt = 0;
	await (daemon as unknown as { reapArtifactsIfDue(): Promise<void> }).reapArtifactsIfDue();
	expect(fs.readdirSync(notificationDir).filter(name => name.startsWith(".gjc-exact-unlink-placeholder-")).length).toBe(0);
	expect(fs.existsSync(endpointArtifact)).toBe(true);
});

test("concurrent generation upgrades reserve one reload attempt", async () => {
	const agentDir = tempDir();
	const s = settings(agentDir);
	const now = 1_000;
	const alive = new Set<number>([999, 4242]);
	const signals: Array<[number, NodeJS.Signals]> = [];
	let pending: { ownerId: string; pid: number } | undefined;
	const fsImpl = daemonFs();
	writeLiveOwner(agentDir, {
		pid: 999, incarnation: "linux:100", ownerId: "old-owner", tokenFingerprint: tokenFingerprint("123456:secret-token"),
		chatId: "42", startedAt: now, heartbeatAt: now, roots: [], version: DAEMON_VERSION,
		generation: DAEMON_GENERATION - 1, acquisitionId: "old-owner", ownershipPhase: "ready",
	});
	const deps = {
		fs: fsImpl,
		pid: 4242,
		now: () => now,
		pidAlive: (pid: number) => alive.has(pid),
		pidIncarnation: () => "linux:100",
		processReference: (pid: number) =>
			pid === 999
				? { incarnation: "linux:100", termination: "cooperative" as const, signalRoot: (signal: NodeJS.Signals) => {
					signals.push([pid, signal]);
					if (signal === "SIGTERM") alive.delete(pid);
				} }
				: undefined,
		spawn: (_command: string, args: string[]) => {
			const ownerId = args[args.indexOf("--owner-id") + 1]!;
			pending = { ownerId, pid: 4244 };
			alive.add(4244);
			return { pid: 4244, unref() {} };
		},
		sleep: async () => {
			if (!pending) return;
			await renewDaemonHeartbeat({
				settings: s, ownerId: pending.ownerId, acquisitionId: pending.ownerId, pid: pending.pid,
				pidIncarnation: () => "linux:100", now: () => now, fs: fsImpl,
			});
		},
		waitStepMs: 1,
		readinessTimeoutMs: 10,
	};
	const results = await Promise.all([
		ensureTelegramDaemonRunningDetailed({ settings: s, cwd: path.join(agentDir, "one"), sessionId: "one" }, deps),
		ensureTelegramDaemonRunningDetailed({ settings: s, cwd: path.join(agentDir, "two"), sessionId: "two" }, deps),
	]);
	expect(results).toContain("reloaded");
	expect(signals.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
});

test("reloadReservationLockOptions budgets acquisition beyond the full in-lock reload window", () => {
	const freshnessWaitMs = 15_000;
	const readinessTimeoutMs = 15_000;
	const retryDelayMs = 100;
	const opts = reloadReservationLockOptions({ freshnessWaitMs, readinessTimeoutMs, retryDelayMs });
	// Worst case held under the lock: freshness poll + graceful(8s) + kill(3s) + readiness.
	const worstCaseHeldMs = freshnessWaitMs + 8_000 + 3_000 + readinessTimeoutMs;
	expect(opts.retries * opts.retryDelayMs).toBeGreaterThan(worstCaseHeldMs);
	// Larger injected readiness budgets scale the acquisition window too.
	const bigger = reloadReservationLockOptions({ freshnessWaitMs: 30_000, readinessTimeoutMs: 30_000, retryDelayMs });
	expect(bigger.retries).toBeGreaterThan(opts.retries);
	// Degenerate inputs stay valid (at least one retry, positive delay).
	const floor = reloadReservationLockOptions({ freshnessWaitMs: 0, readinessTimeoutMs: 0, retryDelayMs: 0 });
	expect(floor.retries).toBeGreaterThanOrEqual(1);
	expect(floor.retryDelayMs).toBeGreaterThanOrEqual(1);
});
