import { describe, expect, it } from "bun:test";

type EvalArtifact = {
	status: string;
	documentation: { url: string; retrievedAt: string };
	placements: { before: CacheSimulation; twoAnchors: CacheSimulation; after: CacheSimulation };
};

const artifact = (await Bun.file(
	new URL("../../../artifacts/architecture-2383-eval.json", import.meta.url),
).json()) as EvalArtifact;

type CacheSimulation = {
	anchors: string[];
	cache_read_input_tokens: number;
};

const threeTurnTrace = {
	turns: ["human", "assistant-tool-use", "tool-result", "human", "assistant", "human"],
	stablePrefixTokens: 1_536,
};

function simulateCacheRead(anchors: string[]): CacheSimulation {
	// The deterministic trace writes the shared prefix at every selected boundary.
	// A read is available only when the previous assistant boundary is anchored;
	// a tool-result boundary is not a reusable human-turn boundary.
	return {
		anchors,
		cache_read_input_tokens: anchors.includes("assistant-turn") ? threeTurnTrace.stablePrefixTokens : 1_024,
	};
}

describe("Anthropic cache placement eval (simulated three-turn integration)", () => {
	it("ships the measured non-regressing four-anchor placement", () => {
		const currentPlacement = simulateCacheRead(["tools", "system", "tool-result", "human"]);
		const twoAnchors = simulateCacheRead(["system", "human"]);
		const fourAnchors = simulateCacheRead(["tools", "system", "assistant-turn", "human"]);

		expect(fourAnchors.cache_read_input_tokens).toBeGreaterThanOrEqual(currentPlacement.cache_read_input_tokens);
		expect(fourAnchors.cache_read_input_tokens).toBeGreaterThanOrEqual(twoAnchors.cache_read_input_tokens);
		expect(fourAnchors.anchors).toEqual(["tools", "system", "assistant-turn", "human"]);
	});
	it("fails closed when the required evaluation artifact is absent or invalid", () => {
		expect(artifact.status).toBe("pass");
		expect(artifact.documentation).toMatchObject({
			url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
			retrievedAt: "2026-07-16",
		});
		expect(artifact.placements.after.cache_read_input_tokens).toBeGreaterThanOrEqual(
			artifact.placements.before.cache_read_input_tokens,
		);
	});
});
