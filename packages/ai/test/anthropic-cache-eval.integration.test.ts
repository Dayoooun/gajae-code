import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, TJsonSchema } from "@gajae-code/ai/types";

type CacheControl = { type: string; ttl?: string };
type Payload = {
	cache_control?: CacheControl;
	messages: Array<{ role: string; content: unknown }>;
};
type EvalArtifact = {
	schemaVersion: 1;
	issue: 2383;
	status: "pass";
	evidenceType: "deterministic-non-billing-provider-payload-structure";
	source: { url: string; retrievedAt: string; codeCommit: string; inputFixtureSha256: string };
	capturedAnchors: { proposed: string[] };
	derivedMetrics: {
		estimator: "floor(utf8Bytes/4)";
		billing: "not-a-billing-estimate";
		proposedSerializedBytes: number;
		proposedStructuralTokenEstimate: number;
	};
	method: string;
	limitations: string;
	testCommand: string;
};

const artifactPath = new URL("../../../artifacts/architecture-2383-eval.json", import.meta.url);
const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const fixture = {
	turns: ["human", "assistant-tool-use", "tool-result", "human", "assistant", "human"],
	toolResult: "Result from source A",
};

function sha256(value: string): Promise<string> {
	return crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(value))
		.then(digest => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	const context: Context = {
		systemPrompt: ["Stable instructions"],
		tools: [
			{
				name: "lookup",
				description: "Looks up an answer.",
				parameters: { type: "object", properties: {} } as TJsonSchema,
			},
		],
		messages: [
			{ role: "user", content: "Find the answer", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "lookup",
				content: [{ type: "text", text: fixture.toolResult }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "Use the result", timestamp: 4 },
		],
	};
	streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function estimatedTokens(bytes: number): number {
	return Math.floor(bytes / 4);
}

describe("Anthropic cache placement eval (deterministic payload structure)", () => {
	it("derives only non-billing structural evidence from the finalized provider payload", async () => {
		expect(await Bun.file(artifactPath).exists()).toBe(true);
		const artifact = (await Bun.file(artifactPath).json()) as EvalArtifact;
		const payload = await capturePayload();
		const serializedBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;

		expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(estimatedTokens(serializedBytes)).toBeGreaterThan(0);
		expect(artifact).toMatchObject({
			schemaVersion: 1,
			issue: 2383,
			status: "pass",
			evidenceType: "deterministic-non-billing-provider-payload-structure",
			source: {
				url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
				retrievedAt: "2026-07-17",
				codeCommit: "0a43140bb",
				inputFixtureSha256: await sha256(JSON.stringify(fixture)),
			},
			capturedAnchors: { proposed: ["cache_control"] },
			derivedMetrics: { estimator: "floor(utf8Bytes/4)", billing: "not-a-billing-estimate" },
		});
		expect(artifact.derivedMetrics.proposedSerializedBytes).toBeGreaterThan(0);
		expect(artifact.derivedMetrics.proposedStructuralTokenEstimate).toBeGreaterThan(0);
		expect(artifact.limitations).toContain("cannot establish cache reuse");
	});
});
