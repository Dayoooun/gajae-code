import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser } from "puppeteer-core";
import * as attach from "../../src/tools/browser/attach";
import { type BrowserHandle, releaseBrowser } from "../../src/tools/browser/registry";

interface FakeBrowserOptions {
	pid?: number;
	close?: () => Promise<void>;
	warmupDir?: string;
}

function makeHeadlessHandle(opts: FakeBrowserOptions = {}): { handle: BrowserHandle; close: ReturnType<typeof vi.fn> } {
	const close = vi.fn(opts.close ?? (async () => {}));
	const browser = {
		connected: true,
		close,
		process: () => (opts.pid === undefined ? null : ({ pid: opts.pid } as never)),
	} as unknown as Browser;
	const handle: BrowserHandle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		browser,
		refCount: 1,
		stealth: { browserSession: null, override: null },
		...(opts.warmupDir ? { warmupDir: opts.warmupDir } : {}),
	};
	return { handle, close };
}

describe("browser registry headless teardown (#698)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("force-kills the headless Chrome process tree on a forced (signal) release", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const { handle, close } = makeHeadlessHandle({ pid: 4242 });

		await releaseBrowser(handle, { kill: true });

		expect(close).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(4242);
	});

	it("kills the captured process even when CDP close hangs on a wedged renderer", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		// close() never resolves: bounded by HEADLESS_FORCE_CLOSE_GRACE_MS so the kill still runs.
		const { handle } = makeHeadlessHandle({ pid: 99, close: () => new Promise<void>(() => {}) });

		await releaseBrowser(handle, { kill: true });

		expect(killSpy).toHaveBeenCalledWith(99);
	});

	it("closes gracefully without killing on a normal release (kill:false)", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const { handle, close } = makeHeadlessHandle({ pid: 4242 });

		await releaseBrowser(handle, { kill: false });

		expect(close).toHaveBeenCalledTimes(1);
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("only disposes once refCount reaches zero", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const { handle, close } = makeHeadlessHandle({ pid: 4242 });
		handle.refCount = 2;

		await releaseBrowser(handle, { kill: true });
		expect(close).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();

		await releaseBrowser(handle, { kill: true });
		expect(close).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(4242);
	});

	it("removes the Chrome profile warm-up dir on release", async () => {
		vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const warmupDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-warmup-test-"));
		fs.writeFileSync(path.join(warmupDir, "Cookies"), "x");
		const { handle } = makeHeadlessHandle({ pid: 4242, warmupDir });

		await releaseBrowser(handle, { kill: false });

		expect(fs.existsSync(warmupDir)).toBe(false);
	});

	it("removes the warm-up dir on a forced release too", async () => {
		vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const warmupDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-warmup-test-"));
		const { handle } = makeHeadlessHandle({ pid: 4242, warmupDir });

		await releaseBrowser(handle, { kill: true });

		expect(fs.existsSync(warmupDir)).toBe(false);
	});

	it("keeps the warm-up dir while refCount is still held", async () => {
		vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const warmupDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-warmup-test-"));
		const { handle } = makeHeadlessHandle({ pid: 4242, warmupDir });
		handle.refCount = 2;

		await releaseBrowser(handle, { kill: false });
		expect(fs.existsSync(warmupDir)).toBe(true);

		await releaseBrowser(handle, { kill: false });
		expect(fs.existsSync(warmupDir)).toBe(false);
	});

	it("tolerates an already-deleted warm-up dir", async () => {
		vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const warmupDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-warmup-test-"));
		fs.rmSync(warmupDir, { recursive: true, force: true });
		const { handle, close } = makeHeadlessHandle({ pid: 4242, warmupDir });

		await releaseBrowser(handle, { kill: false });

		expect(close).toHaveBeenCalledTimes(1);
	});
});
