import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "@gajae-code/coding-agent/config/file-lock";
import { writeCurrentSessionGoalModeState } from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import { resolveSessionIdFromSources, SessionResolutionError } from "@gajae-code/coding-agent/gjc-runtime/session-resolution";
import { validateCliReplay } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-evidence";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-final-qa-"));
	tempDirs.push(dir);
	return dir;
}

async function writeActiveGoal(sessionFile: string, goal: Record<string, unknown>): Promise<void> {
	const timestamp = new Date().toISOString();
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp, cwd: path.dirname(sessionFile) })}\n${JSON.stringify({ type: "mode_change", id: "goal", parentId: null, timestamp, mode: "goal", data: { goal } })}\n`,
	);
}

describe("harness final QA regressions", () => {
	test("rejects path-component session IDs from every explicit boundary source", () => {
		for (const sources of [
			{ flagValue: "../../escape" },
			{ payloadSessionId: "a/b" },
			{ envSessionId: "a\\b" },
			{ flagValue: "." },
			{ flagValue: ".." },
		]) {
			expect(() => resolveSessionIdFromSources(sources)).toThrow(SessionResolutionError);
		}
	});

	test("fails same-process lock reentry without retrying", async () => {
		const dir = await tempDir();
		const lockedFile = path.join(dir, "state.json");
		await withFileLock(lockedFile, async () => {
			await expect(withFileLock(lockedFile, async () => {}, { retries: 50, retryDelayMs: 100 })).rejects.toThrow(
				"File lock reentry",
			);
		});
	});

	test("requires recorded stdout equality even when an invariant matches everything", async () => {
		await expect(
			validateCliReplay(
				process.cwd(),
				{
					kind: "cli-replay",
					schemaVersion: 1,
					replaySafe: true,
					command: ["bun", "-e", 'console.log("actual")'],
					recordedStdout: "recorded\n",
					invariants: [{ type: "regex", value: ".*" }],
				},
				"replay",
				{ live: false },
			),
		).rejects.toThrow("stdout did not match recordedStdout");
	});

	test("matches reworded ultragoal requests by provenance but replaces stale plan provenance", async () => {
		const dir = await tempDir();
		const sessionFile = path.join(dir, "session.jsonl");
		const existingGoal = {
			id: "goal-1",
			objective: "Original wording",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
			provenance: { source: "ultragoal" as const, runId: "run-1", goalId: "aggregate" },
		};
		await writeActiveGoal(sessionFile, existingGoal);
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile,
				objective: "Reworded objective",
				provenance: existingGoal.provenance,
			}),
		).toEqual({ status: "existing_goal", goal: existingGoal });
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile,
				objective: "New plan objective",
				provenance: { source: "ultragoal", runId: "run-2", goalId: "aggregate" },
			}),
		).toMatchObject({ status: "updated", goal: { objective: "New plan objective" } });

		const legacySessionFile = path.join(dir, "legacy-session.jsonl");
		await writeActiveGoal(legacySessionFile, { ...existingGoal, provenance: undefined });
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile: legacySessionFile,
				objective: existingGoal.objective,
				provenance: existingGoal.provenance,
			}),
		).toMatchObject({ status: "existing_goal" });
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile: legacySessionFile,
				objective: "Legacy rewording",
				provenance: existingGoal.provenance,
			}),
		).toMatchObject({ status: "updated", goal: { objective: "Legacy rewording" } });
	});
});
