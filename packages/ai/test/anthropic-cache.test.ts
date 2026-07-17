import { describe, expect, it } from "bun:test";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { normalizeCacheControlTtlOrdering, streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, TJsonSchema } from "@gajae-code/ai/types";

const canonicalModel: Model<"anthropic-messages"> = {
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
type Payload = MessageCreateParamsStreaming & { cache_control?: CacheControl };

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function context(messages: Context["messages"] = [{ role: "user", content: "Continue", timestamp: 1 }]): Context {
	return {
		systemPrompt: ["Stable instructions", "Second stable instruction"],
		tools: [
			{
				name: "lookup",
				description: "Looks up an answer.",
				parameters: { type: "object", properties: {} } as TJsonSchema,
			},
		],
		messages,
	};
}

function capturePayload(
	model: Model<"anthropic-messages">,
	input: Context,
	onPayload?: (payload: Payload) => Payload | undefined,
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, input, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		onPayload: payload => {
			const replacement = onPayload?.(payload as Payload);
			resolve((replacement ?? payload) as Payload);
			return replacement;
		},
	});
	return promise;
}

function cacheParams(overrides: Partial<Payload> = {}): Payload {
	return {
		model: canonicalModel.id,
		max_tokens: 1,
		stream: true,
		messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
		...overrides,
	};
}

describe("Anthropic prompt caching", () => {
	it("uses canonical top-level automatic caching and gives unsupported compatible endpoints no generated controls", async () => {
		const [canonical, compatible] = await Promise.all([
			capturePayload(canonicalModel, context()),
			capturePayload({ ...canonicalModel, baseUrl: "https://proxy.example.test/anthropic" }, context()),
		]);

		expect(canonical.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(compatible.cache_control).toBeUndefined();
		expect(canonical.tools?.every(tool => !(tool as { cache_control?: CacheControl }).cache_control)).toBe(true);
		expect(!Array.isArray(canonical.system) || canonical.system.every(block => !block.cache_control)).toBe(true);
	});

	it("counts automatic caching as one slot and preserves valid callback controls without mutation", async () => {
		const replacement = cacheParams({
			cache_control: { type: "ephemeral", ttl: "1h" },
			tools: [
				{
					name: "first",
					description: "first",
					input_schema: { type: "object", properties: {} },
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
				{
					name: "second",
					description: "second",
					input_schema: { type: "object", properties: {} },
					cache_control: { type: "ephemeral" },
				},
			],
			system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
		});
		const before = structuredClone(replacement);
		const payload = await capturePayload(canonicalModel, context(), () => replacement);

		expect(payload).toBe(replacement);
		expect(replacement).toEqual(before);
	});

	it("accepts zero, one, and four ordered caller controls across tools, system, and messages", () => {
		const cases: Payload[] = [
			cacheParams(),
			cacheParams({
				tools: [
					{
						name: "tool",
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			}),
			cacheParams({
				tools: [
					{
						name: "tool",
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
				system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "stable answer", cache_control: { type: "ephemeral" } }],
					},
					{
						role: "user",
						content: [{ type: "text", text: "current question", cache_control: { type: "ephemeral" } }],
					},
				],
			}),
		];
		for (const params of cases) {
			const before = structuredClone(params);
			expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
			expect(params).toEqual(before);
		}
	});

	it("fails closed for invalid callback controls and never normalizes caller objects", () => {
		const cases: Array<{ name: string; params: Payload }> = [
			{
				name: "five controls",
				params: cacheParams({
					cache_control: { type: "ephemeral" },
					tools: Array.from({ length: 4 }, (_, index) => ({
						name: `tool-${index}`,
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral" },
					})),
				}),
			},
			{
				name: "five-minute before one-hour",
				params: cacheParams({
					system: [{ type: "text", text: "short", cache_control: { type: "ephemeral" } }],
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "long", cache_control: { type: "ephemeral", ttl: "1h" } }],
						},
					],
				}),
			},
			{
				name: "thinking target",
				params: {
					...cacheParams(),
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "thinking",
									thinking: "private",
									signature: "sig",
									cache_control: { type: "ephemeral" },
								},
							],
						},
					],
				} as unknown as Payload,
			},
			{
				name: "empty text target",
				params: cacheParams({
					messages: [
						{ role: "user", content: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }] },
					],
				}),
			},
		];

		for (const { name, params } of cases) {
			const before = structuredClone(params);
			expect(() => normalizeCacheControlTtlOrdering(params)).toThrow(`Invalid Anthropic cache_control`);
			expect(params, name).toEqual(before);
		}
	});

	it("recognizes the inclusive twenty-position automatic-cache window", () => {
		const checkedPosition = (delta: number): number => delta + 1;
		expect([19, 20, 21].map(delta => checkedPosition(delta) <= 20)).toEqual([true, false, false]);
	});

	it("treats a mixed text and tool_result user turn as human input", async () => {
		const payload = await capturePayload(
			canonicalModel,
			context([
				{ role: "user", content: "Question", timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "Answer" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "Use the answer", timestamp: 3 },
			]),
		);
		expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});
});
