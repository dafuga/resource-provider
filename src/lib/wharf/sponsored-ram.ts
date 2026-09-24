export interface SponsoredRamPolicy {
	gameContract: string;
	sponsor: string;
	maxBytes: number;
}

export interface SponsoredRamAction {
	account: string | { toString(): string };
	name: string | { toString(): string };
	authorization: Array<{ actor: string | { toString(): string } }>;
}

/** A sponsor may only buy storage for its own game's signed player action. */
export function planSponsoredRam(
	requester: string,
	actions: SponsoredRamAction[],
	shortageAccount: string | undefined,
	bytes: number,
	policy: SponsoredRamPolicy
): { payer: string; receiver: string; bytes: number } | null {
	if (
		!actions.length ||
		!actions.every(
			(action) =>
				String(action.account) === policy.gameContract &&
				action.authorization.length > 0 &&
				action.authorization.every((auth) => String(auth.actor) === requester)
		)
	) {
		return null;
	}
	if (shortageAccount !== requester) {
		throw new Error('Cannot sponsor a RAM shortage billed to another account.');
	}
	if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > policy.maxBytes) {
		throw new Error('Requested RAM is outside the sponsored per-transaction limit.');
	}
	if (!policy.sponsor || policy.sponsor === requester) {
		throw new Error('RAM sponsor must be a distinct configured account.');
	}
	return { payer: policy.sponsor, receiver: requester, bytes };
}
