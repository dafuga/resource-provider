import { Action, Transaction } from '@wharfkit/antelope';
import type { NameType, PermissionLevel, UInt64 } from '@wharfkit/antelope';

import { getContract } from '../contracts';

import { ANTELOPE_SYSTEM_CONTRACT } from 'src/config';

export function withPrepaidRam(transaction: Transaction, purchase: Action): Transaction {
	const modified = Transaction.from(transaction);
	modified.actions.unshift(purchase);
	return modified;
}

export async function addBuyRAMBytesAction(
	transaction: Transaction,
	payer: PermissionLevel,
	bytes: UInt64,
	receiver: NameType = payer.actor
): Promise<Transaction> {
	const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
	// Storage must exist before the gameplay action allocates its table rows.
	return withPrepaidRam(
		transaction,
		systemContract.action(
			'buyrambytes',
			{
				payer: payer.actor,
				receiver,
				bytes
			},
			{ authorization: [payer] }
		)
	);
}
