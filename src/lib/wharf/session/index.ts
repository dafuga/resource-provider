import { Checksum256, PrivateKey, Session, Signature, Transaction } from '@wharfkit/session';
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey';

import { managerAccount } from '$lib/db/models/manager/manager';
import { providerAccount } from '$lib/db/models/provider/provider';
import type { ServiceAccountData } from '$lib/db/models/service';
import { ANTELOPE_CHAIN_ID, ANTELOPE_NODEOS_API } from 'src/config';

function validateChainConfig(): void {
	if (!ANTELOPE_CHAIN_ID || !ANTELOPE_NODEOS_API) {
		throw new Error('Please set ANTELOPE_CHAIN_ID and ANTELOPE_NODEOS_API.');
	}
}

function createSession(account: ServiceAccountData): Session {
	return new Session({
		chain: {
			id: ANTELOPE_CHAIN_ID,
			url: ANTELOPE_NODEOS_API
		},
		permissionLevel: {
			actor: account.account,
			permission: account.permission
		},
		walletPlugin: new WalletPluginPrivateKey(account.key)
	});
}

let providerSessionPromise: Promise<Session> | null = null;
let managerSessionPromise: Promise<Session> | null = null;

async function initSession(getAccount: () => Promise<ServiceAccountData>): Promise<Session> {
	validateChainConfig();
	return createSession(await getAccount());
}

export function getProviderSession(): Promise<Session> {
	if (!providerSessionPromise) {
		providerSessionPromise = initSession(() => providerAccount.getAccount());
	}
	return providerSessionPromise;
}

export function getManagerSession(): Promise<Session> {
	if (!managerSessionPromise) {
		managerSessionPromise = initSession(() => managerAccount.getAccount());
	}
	return managerSessionPromise;
}

export async function signTransaction(transaction: Transaction): Promise<Signature> {
	const session = await getProviderSession();
	return signWithSession(transaction, session);
}

export async function signManagerTransaction(transaction: Transaction): Promise<Signature> {
	const session = await getManagerSession();
	return signWithSession(transaction, session);
}

function signWithSession(transaction: Transaction, session: Session): Signature {
	const digest = transaction.signingDigest(Checksum256.from(session.chain.id));
	const privateKey = PrivateKey.from(session.walletPlugin.data.privateKey);
	return privateKey.signDigest(digest);
}
