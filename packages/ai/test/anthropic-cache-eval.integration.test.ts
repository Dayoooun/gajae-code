import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, TJsonSchema } from "@gajae-code/ai/types";

type CacheControl = { type: string; ttl?: string };
type PayloadMessage = {
	role: string;
	content: string | Array<{ type: string; cache_control?: CacheControl }>;
};
type Payload = {
	messages: PayloadMessage[];
	system?: Array<{ cache_control?: CacheControl }>;
	tools?: Array<{ cache_control?: CacheControl }>;
};
type EvalArtifact = {
	schemaVersion: 1;
	issue: 2383;
	status: "pass";
	evidenceType: "deterministic-simulated-three-turn-provider-payload-integration";
	source: { url: string; retrievedAt: string; codeCommit: string; inputFixtureSha256: string };
	capturedAnchors: { before: string[]; proposed: string[] };
	derivedMetrics: {
		estimator: "floor(utf8Bytes/4)";
		beforeSharedCachedPrefixBytes: number;
		beforeSharedCachedPrefixTokens: number;
		proposedSharedCachedPrefixBytes: number;
		proposedSharedCachedPrefixTokens: number;
	};
	method: string;
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
	toolResultVariants: ["Result from source A", "Result from source B"],
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

function capturePayload(toolResult: string): Promise<Payload> {
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
				content: [{ type: "text", text: toolResult }],
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

function capturedAnchorPaths(payload: Payload): string[] {
	const anchors: string[] = [];
	for (const [index, tool] of (payload.tools ?? []).entries()) {
		if (tool.cache_control) anchors.push(`tools[${index}]`);
	}
	for (const [index, block] of (payload.system ?? []).entries()) {
		if (block.cache_control) anchors.push(`system[${index}]`);
	}
	for (const [messageIndex, message] of payload.messages.entries()) {
		if (!Array.isArray(message.content)) continue;
		for (const [blockIndex, block] of message.content.entries()) {
			if (block.cache_control) anchors.push(`messages[${messageIndex}].content[${blockIndex}]`);
		}
	}
	return anchors;
}

function serializeThroughMessage(payload: Payload, messageIndex: number): string {
	return JSON.stringify({
		tools: payload.tools,
		system: payload.system,
		messages: payload.messages.slice(0, messageIndex + 1),
	});
}

function currentPlacement(payload: Payload): Payload {
	const current = structuredClone(payload);
	for (const message of current.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) delete block.cache_control;
	}
	const cacheControl = (payload.messages[1]?.content as Array<{ cache_control?: CacheControl }>)[0]?.cache_control;
	const toolResult = current.messages[2]?.content as Array<{ cache_control?: CacheControl }>;
	const currentHuman = current.messages[3]?.content as Array<{ cache_control?: CacheControl }>;
	if (!cacheControl || !toolResult?.[0] || !currentHuman?.[0]) {
		throw new Error("Provider payload lacks the expected assistant, tool-result, or human blocks");
	}
	toolResult[0].cache_control = cacheControl;
	currentHuman[0].cache_control = cacheControl;
	return current;
}

function sharedCachedPrefixBytes(left: string, right: string): number {
	// A cache breakpoint is usable only when the entire serialized prefix through it is byte-identical.
	return left === right ? new TextEncoder().encode(left).byteLength : 0;
}

function estimatedTokens(bytes: number): number {
	return Math.floor(bytes / 4);
}

describe("Anthropic cache placement eval (deterministic three-turn integration)", () => {
	it("derives the committed evidence from provider payload construction and fails closed for missing or tampered fields", async () => {
		expect(await Bun.file(artifactPath).exists()).toBe(true);
		const artifact = (await Bun.file(artifactPath).json()) as EvalArtifact;
		const [firstPayload, secondPayload] = await Promise.all(
			fixture.toolResultVariants.map(toolResult => capturePayload(toolResult)),
		);
		const proposedAnchors = capturedAnchorPaths(firstPayload);
		const firstCurrentPayload = currentPlacement(firstPayload);
		const secondCurrentPayload = currentPlacement(secondPayload);
		const beforeAnchors = capturedAnchorPaths(firstCurrentPayload);
		const beforeBytes = sharedCachedPrefixBytes(
			serializeThroughMessage(firstCurrentPayload, 2),
			serializeThroughMessage(secondCurrentPayload, 2),
		);
		const proposedBytes = sharedCachedPrefixBytes(
			serializeThroughMessage(firstPayload, 1),
			serializeThroughMessage(secondPayload, 1),
		);
		const derivedMetrics = {
			estimator: "floor(utf8Bytes/4)" as const,
			beforeSharedCachedPrefixBytes: beforeBytes,
			beforeSharedCachedPrefixTokens: estimatedTokens(beforeBytes),
			proposedSharedCachedPrefixBytes: proposedBytes,
			proposedSharedCachedPrefixTokens: estimatedTokens(proposedBytes),
		};

		expect(proposedAnchors).toEqual(["tools[0]", "system[0]", "messages[1].content[0]", "messages[3].content[0]"]);
		expect(derivedMetrics.proposedSharedCachedPrefixTokens).toBeGreaterThanOrEqual(
			derivedMetrics.beforeSharedCachedPrefixTokens,
		);
		expect(artifact).toEqual({
			schemaVersion: 1,
			issue: 2383,
			status: "pass",
			evidenceType: "deterministic-simulated-three-turn-provider-payload-integration",
			source: {
				url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
				retrievedAt: "2026-07-16",
				codeCommit: "2797773e",
				inputFixtureSha256: await sha256(JSON.stringify(fixture)),
			},
			capturedAnchors: { before: beforeAnchors, proposed: proposedAnchors },
			derivedMetrics,
			method:
				"Two provider-built payloads use the same three-turn fixture except for the tool-result text. A cache breakpoint is counted only when the entire JSON serialization through that breakpoint is byte-identical across both payloads. Tokens are the deterministic floor of UTF-8 serialized-prefix bytes divided by four.",
			testCommand: "bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
		});
	});
});
