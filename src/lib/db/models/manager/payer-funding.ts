import { and, eq, gte, sql } from 'drizzle-orm';

import { database } from '$lib/db';
import { payerFunding } from '$lib/db/schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 15 * 60 * 1000;

export class PayerFundingLedger {
	// By default the cooldown and rolling cap cover everything one funder sends. With
	// `perRecipient` they are counted per funder and recipient pair, so one funder can keep
	// several accounts topped up without one account's top-up blocking the others.
	reserve(
		funder: string,
		recipient: string,
		units: number,
		dailyLimit: number,
		now: number,
		options: { perRecipient?: boolean } = {}
	) {
		const scope = options.perRecipient
			? and(
					eq(payerFunding.funder, funder),
					eq(payerFunding.recipient, recipient),
					gte(payerFunding.reserved_at, now - DAY_MS)
				)
			: and(eq(payerFunding.funder, funder), gte(payerFunding.reserved_at, now - DAY_MS));
		return database.transaction(
			(tx) => {
				const totals = tx
					.select({
						units: sql<number>`coalesce(sum(${payerFunding.units}), 0)`,
						latest: sql<number | null>`max(${payerFunding.reserved_at})`
					})
					.from(payerFunding)
					.where(scope)
					.get();

				if (totals?.latest != null && now - totals.latest < COOLDOWN_MS) {
					return { status: 'cooldown' } as const;
				}
				if (units > dailyLimit - (totals?.units ?? 0)) {
					return { status: 'limit' } as const;
				}
				const row = tx
					.insert(payerFunding)
					.values({ funder, recipient, units, reserved_at: now })
					.returning({ id: payerFunding.id })
					.get();
				return { status: 'reserved', id: row.id } as const;
			},
			{ behavior: 'immediate' }
		);
	}

	markUnsent(id: number) {
		database.update(payerFunding).set({ units: 0 }).where(eq(payerFunding.id, id)).run();
	}

	recordTransaction(id: number, transactionId: string) {
		database
			.update(payerFunding)
			.set({ transaction_id: transactionId })
			.where(eq(payerFunding.id, id))
			.run();
	}
}

export const payerFundingLedger = new PayerFundingLedger();
