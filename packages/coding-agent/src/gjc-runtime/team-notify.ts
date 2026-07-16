import type {
	GjcTeamMailboxDeliveryInput,
	GjcTeamMailboxDeliveryResult,
	GjcTeamMailboxDeliveryTransport,
} from "./team-store";

export async function deliverTeamMailboxMessage(
	transport: GjcTeamMailboxDeliveryTransport | undefined,
	input: GjcTeamMailboxDeliveryInput,
): Promise<GjcTeamMailboxDeliveryResult | null> {
	if (!transport) return null;
	try {
		return await transport.deliverMailboxMessage(input);
	} catch {
		return null;
	}
}
