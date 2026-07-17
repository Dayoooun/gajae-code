import { describe, expect, test } from "bun:test";
import { ModelBindingsApplier } from "../src/config/model-bindings-applier";
import type { Settings } from "../src/config/settings";

function createSettings(initial: {
	modelRoles: Record<string, string | string[]>;
	agentModelOverrides: Record<string, string | string[]>;
}) {
	const values = {
		modelRoles: { ...initial.modelRoles },
		"task.agentModelOverrides": { ...initial.agentModelOverrides },
	};
	return {
		values,
		settings: {
			get(key: keyof typeof values) {
				return values[key];
			},
			override(key: keyof typeof values, value: (typeof values)[typeof key]) {
				values[key] = value;
			},
		} as unknown as Settings,
	};
}

describe("ModelBindingsApplier", () => {
	test("restores untouched bindings while preserving user edits", () => {
		const { settings, values } = createSettings({
			modelRoles: { default: "openai/gpt-4.1" },
			agentModelOverrides: { executor: "anthropic/claude-sonnet" },
		});
		const applier = new ModelBindingsApplier();
		const configuredChain = ["openai/gpt-5", "anthropic/claude-opus"];

		applier.setBindings({
			modelRoles: { default: configuredChain },
			agentModelOverrides: { planner: "google/gemini-2.5-pro" },
		});
		applier.applyTo(settings);

		expect(values.modelRoles.default).toEqual(configuredChain);
		expect(values.modelRoles.default).not.toBe(configuredChain);
		expect(values["task.agentModelOverrides"]).toEqual({
			executor: "anthropic/claude-sonnet",
			planner: "google/gemini-2.5-pro",
		});

		values.modelRoles.default = "user/chosen-model";
		applier.setBindings(undefined);
		applier.apply();

		expect(values.modelRoles).toEqual({ default: "user/chosen-model" });
		expect(values["task.agentModelOverrides"]).toEqual({ executor: "anthropic/claude-sonnet" });
	});
});
