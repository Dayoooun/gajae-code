export type NativePublishMutationState = "not_committed" | "committed" | "unknown";
export type NativePublishDurabilityState = "not_attempted" | "proven" | "not_provable";
export type NativePublishReason =
	| "none"
	| "destination_exists"
	| "atomic_unavailable"
	| "cross_device"
	| "permission_denied"
	| "io_failure"
	| "invalid_request"
	| "identity_violation"
	| "durability_not_provable"
	| "unknown";
export type NativePublishPrimitive =
	| "renameat2_noreplace"
	| "renameatx_np_excl"
	| "windows_rename_noreplace"
	| "unsupported"
	| "unknown";
export type NativePublishPhase =
	| "preflight"
	| "file_sync"
	| "rename"
	| "source_parent_sync"
	| "destination_parent_sync"
	| "terminal_identity"
	| "complete"
	| "unknown";

type PublishDiagnostic = {
	schemaVersion: 1;
	collectionState: "complete" | "partial" | "unavailable";
	osCode?: number;
	syncFailures?: readonly {
		phase: NativePublishPhase;
		parentRole: "source" | "destination" | "shared" | "staged_file";
		osCode: number;
		kind: "unsupported" | "io" | "permission" | "other";
	}[];
};

export type NativePublishOutcome = {
	readonly ok: boolean;
	readonly code?: string;
	readonly mutationState: NativePublishMutationState;
	readonly durabilityState: NativePublishDurabilityState;
	readonly reason: NativePublishReason;
	readonly primitive: NativePublishPrimitive;
	readonly phase: NativePublishPhase;
	readonly diagnostic: PublishDiagnostic;
};

const mutations = new Set<NativePublishMutationState>(["not_committed", "committed", "unknown"]);
const durability = new Set<NativePublishDurabilityState>(["not_attempted", "proven", "not_provable"]);
const reasons = new Set<NativePublishReason>([
	"none",
	"destination_exists",
	"atomic_unavailable",
	"cross_device",
	"permission_denied",
	"io_failure",
	"invalid_request",
	"identity_violation",
	"durability_not_provable",
	"unknown",
]);
const primitives = new Set<NativePublishPrimitive>([
	"renameat2_noreplace",
	"renameatx_np_excl",
	"windows_rename_noreplace",
	"unsupported",
	"unknown",
]);
const phases = new Set<NativePublishPhase>([
	"preflight",
	"file_sync",
	"rename",
	"source_parent_sync",
	"destination_parent_sync",
	"terminal_identity",
	"complete",
	"unknown",
]);

const malformed: NativePublishOutcome = Object.freeze({
	ok: false,
	mutationState: "unknown",
	durabilityState: "not_provable",
	reason: "unknown",
	primitive: "unknown",
	phase: "unknown",
	diagnostic: Object.freeze({ schemaVersion: 1, collectionState: "unavailable" }),
});

function validDiagnostic(value: unknown): value is PublishDiagnostic {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const diagnostic = value as Record<string, unknown>;
	if (
		!Object.keys(diagnostic).every(key =>
			["schemaVersion", "collectionState", "osCode", "syncFailures"].includes(key),
		)
	)
		return false;
	if (
		diagnostic.schemaVersion !== 1 ||
		!(["complete", "partial", "unavailable"] as const).includes(diagnostic.collectionState as "complete")
	)
		return false;
	const osCode = diagnostic.osCode;
	if (
		osCode !== undefined &&
		(typeof osCode !== "number" || !Number.isInteger(osCode) || osCode < -2147483648 || osCode > 2147483647)
	)
		return false;
	const failures = diagnostic.syncFailures;
	if (failures === undefined) return true;
	if (!Array.isArray(failures) || failures.length > 4) return false;
	return failures.every(failure => {
		if (!failure || typeof failure !== "object" || Object.getPrototypeOf(failure) !== Object.prototype) return false;
		const entry = failure as Record<string, unknown>;
		return (
			Object.keys(entry).every(key => ["phase", "parentRole", "osCode", "kind"].includes(key)) &&
			phases.has(entry.phase as NativePublishPhase) &&
			["source", "destination", "shared", "staged_file"].includes(entry.parentRole as string) &&
			["unsupported", "io", "permission", "other"].includes(entry.kind as string) &&
			typeof entry.osCode === "number" &&
			Number.isInteger(entry.osCode) &&
			entry.osCode >= -2147483648 &&
			entry.osCode <= 2147483647
		);
	});
}

/** Treat incompatible native results as an unknown mutation; never infer safety from legacy fields. */
export function classifyNativePublishOutcome(value: unknown): NativePublishOutcome {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return malformed;
	const result = value as Record<string, unknown>;
	if (
		typeof result.ok !== "boolean" ||
		!mutations.has(result.mutationState as NativePublishMutationState) ||
		!durability.has(result.durabilityState as NativePublishDurabilityState) ||
		!reasons.has(result.reason as NativePublishReason) ||
		!primitives.has(result.primitive as NativePublishPrimitive) ||
		!phases.has(result.phase as NativePublishPhase) ||
		!validDiagnostic(result.diagnostic) ||
		(result.code !== undefined && typeof result.code !== "string")
	)
		return malformed;
	const outcome = result as unknown as NativePublishOutcome;
	if (
		(outcome.mutationState !== "committed" && outcome.durabilityState === "proven") ||
		(outcome.ok && (outcome.mutationState !== "committed" || outcome.reason !== "none")) ||
		(outcome.ok && outcome.durabilityState !== "proven" && outcome.durabilityState !== "not_attempted") ||
		(outcome.reason === "atomic_unavailable" && outcome.mutationState === "committed") ||
		(outcome.mutationState === "not_committed" && outcome.ok)
	)
		return malformed;

	return outcome;
}

export function mayCleanCurrentStaging(outcome: NativePublishOutcome): boolean {
	return !outcome.ok && outcome.mutationState === "not_committed";
}

/** Stable, bounded text for startup errors. Native paths and messages are intentionally excluded. */
export function formatNativePublishDiagnostic(outcome: NativePublishOutcome): string {
	const osCode = outcome.diagnostic.osCode === undefined ? "" : ` os=${outcome.diagnostic.osCode}`;
	const failures = outcome.diagnostic.syncFailures
		?.map(failure => `${failure.parentRole}:${failure.phase}:${failure.kind}:${failure.osCode}`)
		.join(",");
	return `${outcome.reason} primitive=${outcome.primitive} phase=${outcome.phase}${osCode}${failures ? ` sync=${failures}` : ""}`;
}
