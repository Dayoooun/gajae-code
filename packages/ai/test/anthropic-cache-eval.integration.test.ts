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
	source: {
		url: string;
		retrievedAt: string;
		implementationCommit: string;
		finalIntegrationCommit: string;
		inputFixtureSha256: string;
	};
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

function hasGitMetadata(): boolean {
	const result = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0 && result.stdout.toString().trim() === "true";
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
	it("binds finalized payload evidence to immutable implementation and integration provenance", async () => {
		expect(await Bun.file(artifactPath).exists()).toBe(true);
		const artifact = (await Bun.file(artifactPath).json()) as EvalArtifact;
		const payload = await capturePayload();
		const serializedBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
		const fixtureSha256 = await sha256(JSON.stringify(fixture));

		expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(estimatedTokens(serializedBytes)).toBeGreaterThan(0);
		expect(artifact).toEqual({
			schemaVersion: 1,
			issue: 2383,
			status: "pass",
			evidenceType: "deterministic-non-billing-provider-payload-structure",
			source: {
				url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
				retrievedAt: "2026-07-17",
				implementationCommit: "0a43140bb",
				finalIntegrationCommit: "5106a14da",
				inputFixtureSha256: fixtureSha256,
			},
			capturedAnchors: { proposed: ["cache_control"] },
			derivedMetrics: {
				estimator: "floor(utf8Bytes/4)",
				billing: "not-a-billing-estimate",
				proposedSerializedBytes: serializedBytes,
				proposedStructuralTokenEstimate: estimatedTokens(serializedBytes),
			},
			method:
				"One finalized provider-built payload is inspected for the canonical top-level automatic cache_control field. The serialized byte count is a structural diagnostic only.",
			limitations:
				"No request is dispatched and no provider usage or cost fields are observed. The floor(utf8Bytes/4) value is explicitly non-billing, cannot establish cache reuse, and cannot establish a cost improvement.",
			testCommand: "bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
		});

		if (hasGitMetadata()) {
			const ancestry = Bun.spawnSync(
				[
					"git",
					"merge-base",
					"--is-ancestor",
					artifact.source.implementationCommit,
					artifact.source.finalIntegrationCommit,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(ancestry.exitCode).toBe(0);
		}
	});
});
