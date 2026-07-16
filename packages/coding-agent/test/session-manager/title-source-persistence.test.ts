import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	loadEntriesFromFile,
	parseSessionEntries,
	type SessionHeader,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";

import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(entry): entry is SessionHeader =>
			typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session",
	);
}

describe("session title source persistence", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-title-source-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(testAgentDir, { recursive: true, force: true });
	});

	it("persists auto title source across reopen", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Auto title", "auto");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.titleSource).toBe("auto");

		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Auto title");
		expect(reopened.titleSource).toBe("auto");
	});

	it("persists user title source across reopen", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Manual title", "user");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.titleSource).toBe("user");

		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Manual title");
		expect(reopened.titleSource).toBe("user");
	});

	it("appends a bounded header patch and replays v3 and v4 transcripts deterministically", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "x".repeat(1_000_000), timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionFile = session.getSessionFile()!;
		const sizeBeforeRename = fs.statSync(sessionFile).size;

		await session.setSessionName("Patched title", "user");

		const raw = fs.readFileSync(sessionFile, "utf8");
		const records = raw
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string });
		expect(records.at(-1)).toMatchObject({
			type: "header_patch",
			patch: { title: "Patched title", titleSource: "user" },
		});
		expect(fs.statSync(sessionFile).size - sizeBeforeRename).toBeLessThan(300);
		expect((await loadEntriesFromFile(sessionFile))[0]).toMatchObject({
			version: CURRENT_SESSION_VERSION,
			title: "Patched title",
			titleSource: "user",
		});

		const v3 = [
			{ type: "session", version: 3, id: "old", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/old" },
			{ type: "header_patch", patch: { cwd: "/new", title: "New title" } },
			{ type: "header_patch", patch: { title: "Final title" } },
		]
			.map(record => JSON.stringify(record))
			.join("\n");
		expect(parseSessionEntries(v3)[0]).toMatchObject({ version: 3, cwd: "/new", title: "Final title" });
	});

	it("appends an entry patch when replay metadata is sanitized on reopen", async () => {
		const sessionFile = path.join(cwd, "replay.jsonl");
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "replay",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		};
		const entry = {
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "private", thinkingSignature: "stale" }],
				provider: "openai",
				model: "gpt-5",
				timestamp: 1,
				providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		};
		fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);

		const session = await SessionManager.open(sessionFile);
		const records = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(records.at(-1)).toMatchObject({ type: "entry_patch", entryId: "assistant" });
		expect(session.getEntries()[0]).toMatchObject({
			type: "message",
			message: { providerPayload: undefined, content: [{ thinkingSignature: undefined }] },
		});
	});
});
