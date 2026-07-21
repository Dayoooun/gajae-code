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

type SyncFailure = {
	phase: Exclude<NativePublishPhase, "preflight" | "file_sync" | "rename" | "complete" | "unknown">;
	parentRole: "source" | "destination" | "shared" | "staged_file";
	osCode: number;
	kind: "unsupported" | "io" | "permission" | "other";
};

type PublishDiagnostic = {
	schemaVersion: 1;
	collectionState: "complete" | "partial" | "unavailable";
	osCode?: number;
	syncFailures?: readonly SyncFailure[];
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

const mutationStates = new Set<NativePublishMutationState>(["not_committed", "committed", "unknown"]);
const durabilityStates = new Set<NativePublishDurabilityState>(["not_attempted", "proven", "not_provable"]);
const reasons = new Set<NativePublishReason>([
	"none", "destination_exists", "atomic_unavailable", "cross_device", "permission_denied", "io_failure",
	"invalid_request", "identity_violation", "durability_not_provable", "unknown",
]);
const primitives = new Set<NativePublishPrimitive>([
	"renameat2_noreplace", "renameatx_np_excl", "windows_rename_noreplace", "unsupported", "unknown",
]);
const phases = new Set<NativePublishPhase>([
	"preflight", "file_sync", "rename", "source_parent_sync", "destination_parent_sync", "terminal_identity", "complete", "unknown",
]);
const preMutationReasons = new Set<NativePublishReason>([
	"destination_exists", "atomic_unavailable", "cross_device", "permission_denied", "io_failure", "invalid_request", "identity_violation",
]);
const int32 = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const ownPlainRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).every(key => keys.includes(key));

const malformed: NativePublishOutcome = Object.freeze({
	ok: false,
	mutationState: "unknown",
	durabilityState: "not_provable",
	reason: "unknown",
	primitive: "unknown",
	phase: "unknown",
	diagnostic: Object.freeze({ schemaVersion: 1, collectionState: "unavailable" }),
});

function validIdentity(value: unknown): boolean {
	if (value === undefined) return true;
	if (!ownPlainRecord(value) || !exactKeys(value, ["dev", "ino", "size", "mtimeNs", "ctimeNs", "sha256"])) return false;
	const decimal = (field: unknown) => typeof field === "string" && /^-?[0-9]{1,32}$/.test(field);
	return (
		decimal(value.dev) &&
		decimal(value.ino) &&
		decimal(value.size) &&
		decimal(value.mtimeNs) &&
		decimal(value.ctimeNs) &&
		(value.sha256 === undefined || (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)))
	);
}

function validDiagnostic(value: unknown): value is PublishDiagnostic {
	if (!ownPlainRecord(value) || !exactKeys(value, ["schemaVersion", "collectionState", "osCode", "syncFailures"])) return false;
	if (value.schemaVersion !== 1 || !["complete", "partial", "unavailable"].includes(value.collectionState as string)) return false;
	if (value.osCode !== undefined && !int32(value.osCode)) return false;
	if (value.syncFailures === undefined) return true;
	if (!Array.isArray(value.syncFailures) || value.syncFailures.length > 4) return false;
	return value.syncFailures.every(failure => {
		if (!ownPlainRecord(failure) || !exactKeys(failure, ["phase", "parentRole", "osCode", "kind"])) return false;
		return (
			["source_parent_sync", "destination_parent_sync", "terminal_identity"].includes(failure.phase as string) &&
			["source", "destination", "shared", "staged_file"].includes(failure.parentRole as string) &&
			int32(failure.osCode) &&
			["unsupported", "io", "permission", "other"].includes(failure.kind as string)
		);
	});
}

function legalOutcome(outcome: NativePublishOutcome): boolean {
	if (outcome.mutationState === "not_committed")
		return (
			!outcome.ok &&
			outcome.durabilityState === "not_attempted" &&
			preMutationReasons.has(outcome.reason) &&
			["preflight", "file_sync", "rename"].includes(outcome.phase)
		);
	if (outcome.mutationState === "unknown")
		return !outcome.ok && outcome.durabilityState === "not_provable" && outcome.reason === "unknown" && outcome.phase === "rename";
	if (outcome.ok)
		return outcome.reason === "none" && outcome.phase === "complete" && ["proven", "not_attempted"].includes(outcome.durabilityState);
	return (
		outcome.durabilityState === "not_provable" &&
		["durability_not_provable", "identity_violation", "io_failure"].includes(outcome.reason) &&
		["file_sync", "source_parent_sync", "destination_parent_sync", "terminal_identity"].includes(outcome.phase)
	);
}

/** Treat incompatible native results as an unknown mutation; never infer safety from legacy fields. */
export function classifyNativePublishOutcome(value: unknown): NativePublishOutcome {
	if (!ownPlainRecord(value) || !exactKeys(value, ["ok", "code", "identity", "mutationState", "durabilityState", "reason", "primitive", "phase", "diagnostic"]))
		return malformed;
	if (
		typeof value.ok !== "boolean" ||
		(value.code !== undefined && (typeof value.code !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.code))) ||
		!mutationStates.has(value.mutationState as NativePublishMutationState) ||
		!durabilityStates.has(value.durabilityState as NativePublishDurabilityState) ||
		!reasons.has(value.reason as NativePublishReason) ||
		!primitives.has(value.primitive as NativePublishPrimitive) ||
		!phases.has(value.phase as NativePublishPhase) ||
		!validIdentity(value.identity) ||
		!validDiagnostic(value.diagnostic)
	)
		return malformed;
	const outcome = value as unknown as NativePublishOutcome;
	return legalOutcome(outcome) ? outcome : malformed;
}

/** Only a fully validated pre-mutation result permits exact cleanup of current staging. */
export function mayCleanCurrentStaging(outcome: NativePublishOutcome): boolean {
	return outcome.mutationState === "not_committed" && outcome.durabilityState === "not_attempted";
}

/** Stable, bounded text for startup errors. Native paths and messages are intentionally excluded. */
export function formatNativePublishDiagnostic(outcome: NativePublishOutcome): string {
	const osCode = outcome.diagnostic.osCode === undefined ? "" : ` os=${outcome.diagnostic.osCode}`;
	const failures = outcome.diagnostic.syncFailures
		?.map(failure => `${failure.parentRole}:${failure.phase}:${failure.kind}:${failure.osCode}`)
		.join(",");
	return `${outcome.reason} primitive=${outcome.primitive} phase=${outcome.phase}${osCode}${failures ? ` sync=${failures}` : ""}`;
}
