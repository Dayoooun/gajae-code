/** Shared file-backed team state contracts. */
import type { GjcTeamConfig, GjcTeamMailboxMessage } from "./team-runtime";

export type GjcTeamNotificationDeliveryState =
	| "pending"
	| "sent"
	| "queued"
	| "deferred"
	| "failed"
	| "delivered"
	| "acknowledged";
export type GjcTeamPaneAttemptResult = "sent" | "queued" | "deferred" | "failed";
export type GjcTeamMailboxDeliveryTransportKind = "sdk" | "pane";
export interface GjcTeamNotification {
	id: string;
	kind: "mailbox_message" | "worker_lifecycle" | "invalid_attempt";
	team_name: string;
	recipient: string;
	source: { type: "message" | "task" | "worker" | "event"; id: string };
	idempotency_key?: string;
	delivery_state: GjcTeamNotificationDeliveryState;
	pane_attempt_result?: GjcTeamPaneAttemptResult;
	pane_attempt_reason?: string;
	pane_attempt_at?: string;
	created_at: string;
	updated_at: string;
	replay_count: number;
}
export interface GjcTeamMailboxDeliveryInput {
	team_name: string;
	state_dir: string;
	config: GjcTeamConfig;
	notification: GjcTeamNotification;
	message: GjcTeamMailboxMessage;
	cwd: string;
	env: NodeJS.ProcessEnv;
}
export type GjcTeamMailboxDeliveryResult =
	| { transport: "sdk"; state: GjcTeamNotificationDeliveryState; reason?: string }
	| { transport: "pane"; state: GjcTeamPaneAttemptResult; reason?: string };
export interface GjcTeamMailboxDeliveryTransport {
	deliverMailboxMessage(input: GjcTeamMailboxDeliveryInput): Promise<GjcTeamMailboxDeliveryResult | null>;
}
