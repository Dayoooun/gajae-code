import type { GjcTeamStartOptions } from "./team-runtime";
export function withTeamLaunchTransport(
	options: GjcTeamStartOptions,
	mailboxDeliveryTransport: GjcTeamStartOptions["mailboxDeliveryTransport"],
): GjcTeamStartOptions {
	return { ...options, mailboxDeliveryTransport };
}
