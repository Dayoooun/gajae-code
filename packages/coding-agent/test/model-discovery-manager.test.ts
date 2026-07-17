import { describe, expect, test } from "bun:test";
import { ModelDiscoveryManager } from "../src/config/model-discovery-manager";

describe("ModelDiscoveryManager", () => {
	test("tracks provider inputs, statuses, and reset lifecycle independently", () => {
		const manager = new ModelDiscoveryManager<{ provider: string; source: string }, { status: string }>();
		const providers = [
			{ provider: "openai", source: "config" },
			{ provider: "ollama", source: "config" },
		];

		manager.setProviders(providers);
		providers.push({ provider: "anthropic", source: "caller mutation" });
		manager.addProvider({ provider: "openai", source: "override" });
		manager.setState("openai", { status: "ready" });

		expect(manager.providers).toEqual([
			{ provider: "openai", source: "config" },
			{ provider: "ollama", source: "config" },
			{ provider: "openai", source: "override" },
		]);
		expect(manager.providerIds()).toEqual(new Set(["openai", "ollama"]));
		expect(manager.getState("openai")).toEqual({ status: "ready" });

		manager.reset();

		expect(manager.providers).toEqual([]);
		expect(manager.getState("openai")).toBeUndefined();
	});
});
