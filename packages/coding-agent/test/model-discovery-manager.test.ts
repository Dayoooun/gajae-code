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

	test("snapshots provider and state values instead of retaining caller aliases", () => {
		const manager = new ModelDiscoveryManager<
			{ provider: string; headers: Record<string, string> },
			{ models: string[] }
		>();
		const provider = { provider: "openai", headers: { authorization: "original" } };
		const state = { models: ["gpt-5"] };

		manager.setProviders([provider]);
		manager.setState("openai", state);
		provider.headers.authorization = "caller mutation";
		state.models.push("caller-model");
		const snapshot = manager.providers[0]!;
		snapshot.headers.authorization = "reader mutation";
		manager.getState("openai")?.models.push("reader-model");

		expect(manager.providers).toEqual([{ provider: "openai", headers: { authorization: "original" } }]);
		expect(manager.getState("openai")).toEqual({ models: ["gpt-5"] });
	});

	test("rejects stale same-provider refresh completions without blocking other providers", async () => {
		const manager = new ModelDiscoveryManager<{ provider: string }, { status: string }>();
		manager.setProviders([{ provider: "openai" }, { provider: "anthropic" }]);
		let finishFirst!: (value: string) => void;
		const first = manager.refresh(
			"openai",
			() =>
				new Promise<string>(resolve => {
					finishFirst = resolve;
				}),
		);
		const second = manager.refresh("openai", async () => "newest");
		const otherProvider = manager.refresh("anthropic", async () => "other");

		expect(await second).toEqual({ current: true, value: "newest" });
		expect(await otherProvider).toEqual({ current: true, value: "other" });
		finishFirst("stale");
		expect(await first).toEqual({ current: false, value: "stale" });

		const staleToken = manager.beginRefresh("openai");
		manager.beginRefresh("openai");
		expect(manager.setState("openai", { status: "stale" }, staleToken)).toBeFalse();
		expect(manager.getState("openai")).toBeUndefined();
	});
});
