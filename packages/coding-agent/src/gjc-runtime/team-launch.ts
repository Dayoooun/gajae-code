import { SPAWN_PROVENANCE_ENV } from "../sdk/bus/config";
import type { GjcTeamConfig, GjcTeamStartOptions, GjcTeamWorker } from "./team-runtime";

/** Launch-specific option wiring kept separate from runtime dispatch. */
export function withTeamLaunchTransport(
	options: GjcTeamStartOptions,
	mailboxDeliveryTransport: GjcTeamStartOptions["mailboxDeliveryTransport"],
): GjcTeamStartOptions {
	return { ...options, mailboxDeliveryTransport };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** @internal Exported for unit tests. */
export function buildWorkerCommand(
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	platform: NodeJS.Platform = process.platform,
): string {
	const quote = platform === "win32" ? powershellQuote : shellQuote;
	const envAssignment = (key: string, value: string): string =>
		platform === "win32" ? `$env:${key} = ${quote(value)};` : `${key}=${quote(value)}`;
	const workspace = worker.worktree_path
		? `Worker worktree: ${worker.worktree_path}.`
		: `Worker cwd: ${config.leader.cwd}.`;
	const prompt =
		[
			`You are ${worker.id} in gjc team ${config.team_name}.`,
			`Team state root: ${config.state_root}.`,
			workspace,
			`Team brief (context only): ${config.task}`,
			"Before implementation, claim your worker-owned task and treat the claimed task record as the source of truth. Do not implement directly from the broad team brief.",
			`Before claiming work, send startup ACK: gjc team api worker-startup-ack --input '{"team_name":"${config.team_name}","worker_id":"${worker.id}","protocol_version":"1"}' --json.`,
			"Use gjc team api update-worker-status to report task-local activity, then claim-task/transition-task-status with this worker id; keep heartbeat current during long work, record completion_evidence (summary plus a passed command or verified inspection/artifact item) before completed, and do not mutate leader-owned goal state.",
		]
			.join("\n")
			.replace(/[\uFEFF\u200B]/g, "")
			.replace(/\r?\n+/g, " ")
			.trim() || `Worker ${worker.id} ready.`;
	const envLines = [
		envAssignment("GJC_TEAM_WORKER", `${config.team_name}/${worker.id}`),
		envAssignment("GJC_TEAM_INTERNAL_WORKER", `${config.team_name}/${worker.id}`),
		envAssignment("GJC_TEAM_NAME", config.team_name),
		envAssignment("GJC_TEAM_WORKER_ID", worker.id),
		envAssignment("GJC_TEAM_STATE_ROOT", config.state_root),
		envAssignment("GJC_TEAM_LEADER_CWD", config.leader.cwd),
		envAssignment("GJC_TEAM_DISPLAY_NAME", config.display_name),
		envAssignment(SPAWN_PROVENANCE_ENV, config.leader.session_id.trim() || config.team_name),
		...(worker.worktree_path ? [envAssignment("GJC_TEAM_WORKTREE_PATH", worker.worktree_path)] : []),
	];
	const joined = envLines.join(" ");
	if (platform === "win32") return `& { ${joined} & ${config.worker_command} ${quote(prompt)} }`;
	return `${joined} ${config.worker_command} ${quote(prompt)}`;
}
