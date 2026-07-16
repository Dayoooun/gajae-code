import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@gajae-code/utils";

const SPILL_URI = /artifact:\/\/(\d+)/;

describe("AgentSession pre-admission artifact spill", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		tempDir = undefined;
		session = undefined;
		authStorage = undefined;
	});

	it("spills one oversized result before context admission and preserves a readable artifact", async () => {
		tempDir = TempDir.createSync("@gjc-pre-admission-spill-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: {
				model: { ...model, contextWindow: 200_000, maxTokens: 128_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						stopReason: "stop",
						usage: {
							input: 100,
							output: 10,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 110,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.preAdmissionArtifactSpill": true,
				"compaction.thresholdTokens": 3_000,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const fullText = `packages/coding-agent/src/session/messages.ts\n${"middle\n".repeat(10_000)}terminal-status`;
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "large-read",
			toolName: "read",
			content: [{ type: "text", text: fullText }],
			isError: false,
			timestamp: Date.now(),
		};
		const { promise: spillComplete, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_end" && event.message === toolResult) resolve();
		});
		agent.emitExternalEvent({ type: "message_end", message: toolResult });
		await withTimeout(spillComplete, 1_000, "Artifact spill did not complete");

		const preview = toolResult.content.find(block => block.type === "text");
		expect(preview?.type).toBe("text");
		if (preview?.type !== "text") throw new Error("Expected text preview");
		expect(preview.text).toStartWith("packages/coding-agent/src/session/messages.ts");
		expect(preview.text).toContain("terminal-status");
		expect(preview.text).toContain(crypto.createHash("sha256").update(fullText).digest("hex"));
		const artifactId = preview.text.match(SPILL_URI)?.[1];
		expect(artifactId).toBeDefined();
		if (!artifactId) throw new Error("Expected artifact URI");
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		expect(artifactPath).not.toBeNull();
		if (!artifactPath) throw new Error("Expected artifact path");
		expect(await fs.readFile(artifactPath, "utf8")).toBe(fullText);

		await session.prompt("continue after the large read");
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);

		expect(Settings.isolated().get("tools.preAdmissionArtifactSpill")).toBe(false);
		session.settings.set("tools.preAdmissionArtifactSpill", false);
		const disabledResult: ToolResultMessage = {
			...toolResult,
			toolCallId: "large-read-disabled",
			content: [{ type: "text", text: fullText }],
		};
		const { promise: disabledComplete, resolve: resolveDisabled } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_end" && event.message === disabledResult) resolveDisabled();
		});
		agent.emitExternalEvent({ type: "message_end", message: disabledResult });
		await withTimeout(disabledComplete, 1_000, "Disabled artifact spill did not complete");
		expect(disabledResult.content).toEqual([{ type: "text", text: fullText }]);
	});
});
