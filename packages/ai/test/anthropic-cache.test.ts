import { describe, expect, it } from "bun:test";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { normalizeCacheControlTtlOrdering, streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, TJsonSchema } from "@gajae-code/ai/types";

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

type CacheControl = { type: string; ttl?: string };
type PayloadMessage = {
	role: string;
	content: string | Array<{ type: string; text?: string; cache_control?: CacheControl }>;
};
type Payload = {
	messages: PayloadMessage[];
	system?: Array<{ cache_control?: CacheControl }>;
	tools?: Array<{ cache_control?: CacheControl }>;
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(context: Context): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function cacheControl(message: PayloadMessage): CacheControl | undefined {
	return Array.isArray(message.content)
		? message.content.find(block => block.cache_control)?.cache_control
		: undefined;
}

describe("Anthropic prompt cache breakpoints", () => {
	it("uses the previous assistant boundary as the third anchor, not an adjacent tool result", async () => {
		const payload = await capturePayload({
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
					content: [{ type: "text", text: "Result" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "Use the result", timestamp: 4 },
			],
		});

		expect(payload.system?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(payload.tools?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(payload.messages.map(message => [message.role, cacheControl(message)])).toEqual([
			["user", undefined],
			["assistant", { type: "ephemeral", ttl: "1h" }],
			["user", undefined],
			["user", { type: "ephemeral", ttl: "1h" }],
		]);
	});

	it("preserves an externally supplied 1h marker before later five-minute markers", () => {
		const params = {
			model: model.id,
			max_tokens: 1,
			stream: true,
			tools: [
				{
					name: "external_tool",
					description: "An externally cached tool.",
					input_schema: { type: "object", properties: {} },
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			system: [{ type: "text", text: "Later five-minute cache", cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: "Continue" }],
		} as MessageCreateParamsStreaming;

		normalizeCacheControlTtlOrdering(params);

		expect((params.tools?.[0] as { cache_control?: CacheControl }).cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});
});
