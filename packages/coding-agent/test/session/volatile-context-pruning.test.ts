import { describe, expect, it } from "bun:test";
import {
	pruneSupersededMaintenanceReminders,
	pruneSupersededVolatileProjectContext,
} from "../../src/session/volatile-context-pruning";

const custom = (id: string, customType: string, content: string) => ({
	id,
	parentId: null,
	timestamp: new Date().toISOString(),
	type: "custom_message" as const,
	customType,
	content,
	display: false,
});

describe("maintenance custom-message pruning", () => {
	it("keeps only the latest volatile project context", () => {
		const entries = [custom("one", "volatile-project-context", "old tree"), custom("two", "volatile-project-context", "new tree")];
		const result = pruneSupersededVolatileProjectContext(entries);
		expect(result.changed.map(entry => entry.id)).toEqual(["one"]);
		expect(entries[0]?.content).toBe("");
		expect(entries[1]?.content).toBe("new tree");
	});

	it("retires only a prior same-kind singleton reminder", () => {
		const entries = [
			custom("one", "goal-reminder", "old"),
			custom("two", "todo-reminder", "independent"),
			custom("three", "goal-reminder", "new"),
		];
		const result = pruneSupersededMaintenanceReminders(entries);
		expect(result.changed.map(entry => entry.id)).toEqual(["one"]);
		expect(entries[1]?.content).toBe("independent");
		expect(entries[2]?.content).toBe("new");
	});
});
