import type { CustomMessageEntry, SessionEntry } from "./session-manager";

/**
 * Volatile context is refreshed for every prompt. Only its newest copy is useful;
 * replacing older copies at a maintenance boundary preserves the audit trail
 * without repeatedly charging the model for stale workspace snapshots.
 */
export function pruneSupersededVolatileProjectContext(entries: readonly SessionEntry[]): {
	changed: CustomMessageEntry[];
	bytesSaved: number;
} {
	let latest = -1;
	entries.forEach((entry, index) => {
		if (entry.type === "custom_message" && entry.customType === "volatile-project-context") latest = index;
	});
	if (latest < 0) return { changed: [], bytesSaved: 0 };

	const changed: CustomMessageEntry[] = [];
	let bytesSaved = 0;
	entries.forEach((entry, index) => {
		if (index >= latest || entry.type !== "custom_message" || entry.customType !== "volatile-project-context") return;
		const content = typeof entry.content === "string" ? entry.content : entry.content.map(block => block.type === "text" ? block.text : "").join("\n");
		if (!content) return;
		entry.content = "";
		bytesSaved += Buffer.byteLength(content, "utf-8");
		changed.push(entry as CustomMessageEntry);
	});
	return { changed, bytesSaved };
}

/** Retire superseded singleton maintenance reminders without touching ordinary user context. */
export function pruneSupersededMaintenanceReminders(entries: readonly SessionEntry[]): {
	changed: CustomMessageEntry[];
	bytesSaved: number;
} {
	const latest = new Map<string, number>();
	entries.forEach((entry, index) => {
		if (entry.type === "custom_message" && /(?:goal|todo|checkpoint).*reminder|reminder.*(?:goal|todo|checkpoint)/.test(entry.customType)) {
			latest.set(entry.customType, index);
		}
	});
	const changed: CustomMessageEntry[] = [];
	let bytesSaved = 0;
	entries.forEach((entry, index) => {
		if (entry.type !== "custom_message" || latest.get(entry.customType) === undefined || latest.get(entry.customType) === index) return;
		const text = typeof entry.content === "string" ? entry.content : entry.content.map(block => block.type === "text" ? block.text : "").join("\n");
		if (!text) return;
		entry.content = "";
		bytesSaved += Buffer.byteLength(text, "utf-8");
		changed.push(entry);
	});
	return { changed, bytesSaved };
}
