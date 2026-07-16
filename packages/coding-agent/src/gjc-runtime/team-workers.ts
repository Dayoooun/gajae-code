import type { GjcTeamConfig, GjcTeamWorker } from "./team-runtime";
export interface GjcTeamWorkerLifecycleContext {
	config: GjcTeamConfig;
	worker: GjcTeamWorker;
	cwd: string;
	env: NodeJS.ProcessEnv;
}
export function workerLifecycleContext(
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	cwd: string,
	env: NodeJS.ProcessEnv,
): GjcTeamWorkerLifecycleContext {
	return { config, worker, cwd, env };
}
