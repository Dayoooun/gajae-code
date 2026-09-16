import { describe, expect, test } from "bun:test";
import { commands } from "../src/cli-main";
import { SESSION_OVERSIZED_RECOVERY_MESSAGE, SessionNearLimitAppendError } from "../src/session/session-manager";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../src/slash-commands/builtin-registry";

/**
 * Recovery guidance must only name commands a user can actually run.
 *
 * Both oversized-session messages told users to run `gjc export <session-file>`.
 * There is no `export` subcommand (`cli.ts` registers none), so the shell starts
 * a fresh interactive agent that reads "export" as a prompt: the operator loses
 * the recovery they were told to perform and still holds an unwritable session.
 * The root `--export` flag is unrelated — it renders HTML and exits, which never
 * produces a resumable session.
 *
 * These tests pin the property that matters (every referenced command resolves),
 * not one blessed sentence, so rewording stays free while a dead command fails.
 */

/** `gjc <name>` tokens referenced by a message, excluding root flags. */
function referencedCliCommands(message: string): string[] {
	return [...message.matchAll(/`gjc\s+([a-z][a-z0-9-]*)/g)].map(match => match[1]);
}

/** `/name` slash commands referenced by a message. */
function referencedSlashCommands(message: string): string[] {
	return [...message.matchAll(/`\/([a-z][a-z0-9-]*)`/g)].map(match => match[1]);
}

const cliCommandNames = new Set(commands.flatMap(entry => [entry.name, ...(entry.aliases ?? [])]));
const slashCommandNames = new Set(BUILTIN_SLASH_COMMAND_DEFS.map(entry => entry.name));

function nearLimitMessage(entryRetained: boolean): string {
	return new SessionNearLimitAppendError({
		entryBytes: 4096,
		liveBytes: 128 * 1024 * 1024 - 1024,
		capBytes: 128 * 1024 * 1024,
		entryRetained,
	}).message;
}

const guidanceMessages: Array<[string, string]> = [
	["oversized resume", SESSION_OVERSIZED_RECOVERY_MESSAGE],
	["near-limit append (entry retained)", nearLimitMessage(true)],
	["near-limit append (entry rolled back)", nearLimitMessage(false)],
];

describe("session recovery guidance references runnable commands", () => {
	test.each(guidanceMessages)("%s names only registered CLI commands", (_label, message) => {
		for (const name of referencedCliCommands(message)) {
			expect(cliCommandNames).toContain(name);
		}
	});

	test.each(guidanceMessages)("%s names only registered slash commands", (_label, message) => {
		for (const name of referencedSlashCommands(message)) {
			expect(slashCommandNames).toContain(name);
		}
	});

	test("the guard rejects the `gjc export` instruction that shipped", () => {
		// Guards the detector itself: without this, deleting the recovery text
		// entirely would pass every assertion above.
		expect(referencedCliCommands("Use `gjc export <session-file>` to recover.")).toEqual(["export"]);
		expect(cliCommandNames).not.toContain("export");
	});

	test("every guidance message still offers at least one recovery action", () => {
		for (const [, message] of guidanceMessages) {
			const referenced = [...referencedCliCommands(message), ...referencedSlashCommands(message)];
			expect(referenced.length).toBeGreaterThan(0);
		}
	});

	test("near-limit guidance offers a recovery that works at the cap", () => {
		// `/compact` alone is not enough: the near-limit path retains the failed
		// entry, so a compaction-tailed transcript makes prepareCompaction return
		// undefined ("Already compacted") and the only advertised route is gone.
		// Guidance must also name a command that starts a fresh transcript.
		for (const retained of [true, false]) {
			expect(referencedSlashCommands(nearLimitMessage(retained))).toContain("new");
		}
	});
});
