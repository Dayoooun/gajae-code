import { describe, expect, it } from "bun:test";
import { recoverOrphanedBackups, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@gajae-code/coding-agent/session/session-storage";

class RenameTrackingStorage extends MemorySessionStorage {
	renames = 0;

	override rename(source: string, target: string): Promise<void> {
		this.renames++;
		return super.rename(source, target);
	}
}

describe("SessionManager append-only header patches", () => {
	it("appends a bounded rename patch without replacing the existing session file", async () => {
		const storage = new RenameTrackingStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		await session.ensureOnDisk();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const before = storage.readTextSync(sessionFile);
		storage.renames = 0;

		await expect(session.setSessionName("renamed session", "user")).resolves.toBe(true);

		const after = storage.readTextSync(sessionFile);
		expect(after.startsWith(before)).toBe(true);
		const patch = JSON.parse(after.slice(before.length));
		expect(patch).toEqual({
			type: "header_patch",
			patch: { title: "renamed session", titleSource: "user" },
		});
		expect(after.length - before.length).toBeLessThan(128);
		expect(storage.renames).toBe(0);

		session.appendMessage({ role: "user", content: "after patch", timestamp: Date.now() });
		await expect(session.flush()).resolves.toBeUndefined();
	});
});

describe("recoverOrphanedBackups", () => {
	it("promotes an orphaned <basename>.jsonl.<snowflake>.bak back to the primary path when the primary is missing", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-abc.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(backup, '{"type":"session","id":"abc"}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(storage.existsSync(backup)).toBe(false);
		expect(storage.readTextSync(primary)).toBe('{"type":"session","id":"abc"}\n');
	});

	it("leaves the backup alone when the primary already exists", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-xyz.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(primary, '{"type":"session","id":"xyz","keep":true}\n');
		storage.writeTextSync(backup, '{"type":"session","id":"xyz","stale":true}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(storage.readTextSync(primary)).toContain('"keep":true');
		expect(storage.existsSync(backup)).toBe(true);
	});

	it("picks the newest backup when multiple orphans exist for the same primary", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-multi.jsonl`;
		const older = `${primary}.100.bak`;
		const newer = `${primary}.200.bak`;
		storage.writeTextSync(older, "older");
		// Force the newer backup to have a strictly higher mtime so recovery is deterministic.
		await Bun.sleep(5);
		storage.writeTextSync(newer, "newer");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(storage.readTextSync(primary)).toBe("newer");
	});
});
