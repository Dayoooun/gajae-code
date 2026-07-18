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
type Placement = "oldPlacement" | "newPlacement";
type EvalArtifact = {
	schemaVersion: 2;
	issue: 2383;
	status: "pass";
	evidenceType: "deterministic-simulated-three-turn-provider-payload-integration";
	source: { url: string; retrievedAt: string; codeCommit: string; inputFixtureSha256: string };
	derivationCommands: string[];
	capturedAnchors: Record<Placement, string[]>;
	payloads: Record<Placement, Array<{ sha256: string; breakpoints: Record<string, string> }>>;
	threeTurnCacheReadInputTokens: Record<Placement, number[]>;
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
	turns: ["human", "assistant-tool-use", "tool-result", "human"],
	toolResultVariants: ["Result from source A", "Result from source B", "Result from source C"],
};

function sha256(value: string): Promise<string> {
	return crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(value))
		.then(digest => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
}

function mergedHead(): string {
	const result = Bun.spawnSync(["git", "log", "--merges", "-1", "--format=%H"]);
	if (result.exitCode !== 0) throw new Error("Unable to identify the merge commit that produced this evidence");
	return new TextDecoder().decode(result.stdout).trim();
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

function oldPlacement(payload: Payload): Payload {
	const old = structuredClone(payload);
	for (const message of old.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) delete block.cache_control;
	}
	const cacheControl = (payload.messages[1]?.content as Array<{ cache_control?: CacheControl }>)[0]?.cache_control;
	const toolResult = old.messages[2]?.content as Array<{ cache_control?: CacheControl }>;
	const currentHuman = old.messages[3]?.content as Array<{ cache_control?: CacheControl }>;
	if (!cacheControl || !toolResult?.[0] || !currentHuman?.[0]) {
		throw new Error("Provider payload lacks the expected assistant, tool-result, or human blocks");
	}
	toolResult[0].cache_control = cacheControl;
	currentHuman[0].cache_control = cacheControl;
	return old;
}

function breakpointInputs(payload: Payload): Record<string, string> {
	const inputs: Record<string, string> = {};
	for (const path of capturedAnchorPaths(payload)) {
		if (path.startsWith("tools[")) inputs[path] = JSON.stringify({ tools: payload.tools });
		else if (path.startsWith("system["))
			inputs[path] = JSON.stringify({ tools: payload.tools, system: payload.system });
		else {
			const match = /messages\[(\d+)]/.exec(path);
			if (!match) throw new Error(`Unknown cache breakpoint: ${path}`);
			inputs[path] = serializeThroughMessage(payload, Number(match[1]));
		}
	}
	return inputs;
}

function estimatedTokens(input: string): number {
	return Math.floor(new TextEncoder().encode(input).byteLength / 4);
}

function simulatedCacheReadInputTokens(payloads: Payload[]): number[] {
	const seenBreakpoints: string[] = [];
	return payloads.map(payload => {
		const inputs = Object.values(breakpointInputs(payload));
		const cacheRead = Math.max(0, ...inputs.filter(input => seenBreakpoints.includes(input)).map(estimatedTokens));
		seenBreakpoints.push(...inputs);
		return cacheRead;
	});
}

async function deriveEvidence(): Promise<EvalArtifact> {
	const newPayloads = await Promise.all(fixture.toolResultVariants.map(capturePayload));
	const oldPayloads = newPayloads.map(oldPlacement);
	const payloadEvidence = async (payloads: Payload[]) =>
		Promise.all(
			payloads.map(async payload => ({
				sha256: await sha256(JSON.stringify(payload)),
				breakpoints: Object.fromEntries(
					await Promise.all(
						Object.entries(breakpointInputs(payload)).map(async ([path, input]) => [path, await sha256(input)]),
					),
				),
			})),
		);
	const artifact: EvalArtifact = {
		schemaVersion: 2,
		issue: 2383,
		status: "pass",
		evidenceType: "deterministic-simulated-three-turn-provider-payload-integration",
		source: {
			url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
			retrievedAt: "2026-07-16",
			codeCommit: mergedHead(),
			inputFixtureSha256: await sha256(JSON.stringify(fixture)),
		},
		derivationCommands: [
			"git log --merges -1 --format=%H",
			"WRITE_ARCHITECTURE_2383_EVAL=1 bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
			"bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
		],
		capturedAnchors: {
			oldPlacement: capturedAnchorPaths(oldPayloads[0]),
			newPlacement: capturedAnchorPaths(newPayloads[0]),
		},
		payloads: {
			oldPlacement: await payloadEvidence(oldPayloads),
			newPlacement: await payloadEvidence(newPayloads),
		},
		threeTurnCacheReadInputTokens: {
			oldPlacement: simulatedCacheReadInputTokens(oldPayloads),
			newPlacement: simulatedCacheReadInputTokens(newPayloads),
		},
		method:
			"Each turn is a real streamAnthropic onPayload request constructed from the same fixture with a distinct tool-result value. For each placement, the simulator retains every cache_control breakpoint input from preceding turns and reports the largest byte-identical retained breakpoint as floor(UTF-8 bytes / 4) cache_read_input_tokens. The old placement moves the provider-generated assistant marker to the tool-result block; the new placement is the provider-generated payload unchanged.",
		testCommand: "bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
	};
	if (
		artifact.threeTurnCacheReadInputTokens.newPlacement.some(
			(value, index) => value < artifact.threeTurnCacheReadInputTokens.oldPlacement[index],
		)
	) {
		throw new Error("New cache placement regresses simulated cache_read_input_tokens");
	}
	return artifact;
}

describe("Anthropic cache placement eval (deterministic three-turn integration)", () => {
	it("derives the committed evidence from real provider payloads and fails closed for missing or tampered fields", async () => {
		const artifact = await deriveEvidence();
		if (process.env.WRITE_ARCHITECTURE_2383_EVAL === "1") {
			await Bun.write(artifactPath, `${JSON.stringify(artifact, null, "\t")}\n`);
		}
		expect(await Bun.file(artifactPath).json()).toEqual(artifact);
		expect(artifact.capturedAnchors.newPlacement).toEqual([
			"tools[0]",
			"system[0]",
			"messages[1].content[0]",
			"messages[3].content[0]",
		]);
		for (const [index, oldCacheRead] of artifact.threeTurnCacheReadInputTokens.oldPlacement.entries()) {
			expect(artifact.threeTurnCacheReadInputTokens.newPlacement[index]).toBeGreaterThanOrEqual(oldCacheRead);
		}
	});
});
