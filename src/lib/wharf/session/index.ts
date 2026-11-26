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

// Cache the session, but never cache a failure: a transient error must not leave every later
// call rejected for the life of the process.
export function cacheSession(
	current: Promise<Session> | null,
	set: (value: Promise<Session> | null) => void,
	getAccount: () => Promise<ServiceAccountData>
): Promise<Session> {
	if (current) return current;
	const promise = initSession(getAccount).catch((error) => {
		set(null);
		throw error;
	});
	set(promise);
	return promise;
}

export function getProviderSession(): Promise<Session> {
	return cacheSession(
		providerSessionPromise,
		(value) => (providerSessionPromise = value),
		() => providerAccount.getAccount()
	);
}

export function getManagerSession(): Promise<Session> {
	return cacheSession(
		managerSessionPromise,
		(value) => (managerSessionPromise = value),
		() => managerAccount.getAccount()
	);
}

export async function signTransaction(transaction: Transaction): Promise<Signature> {
	const session = await getProviderSession();
	const digest = transaction.signingDigest(Checksum256.from(session.chain.id));
	const privateKey = PrivateKey.from(session.walletPlugin.data.privateKey);
	return privateKey.signDigest(digest);
}
