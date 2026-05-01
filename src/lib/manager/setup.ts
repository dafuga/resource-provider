import { API, Int64, KeyWeight, NameType, PrivateKey, Session } from '@wharfkit/session';

import { getContract } from '$lib/wharf/contracts';
import { ANTELOPE_SYSTEM_CONTRACT, MANAGER_RAM_MINIMUM_KB } from 'src/config';

export async function makeUpdateAuthAction(
	manager: Session,
	existingPermission?: API.v1.AccountPermission
) {
	const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);

	const keys: KeyWeight[] = [
		KeyWeight.from({
			key: PrivateKey.from(manager.walletPlugin.data.privateKey).toPublic(),
			weight: 1
		})
	];

	// Retain any other keys that may exist on the permission
	if (existingPermission && existingPermission.required_auth.keys) {
		for (const k of existingPermission.required_auth.keys) {
			if (!k.key.equals(manager.walletPlugin.data.privateKey.toPublic())) {
				keys.push(KeyWeight.from({ key: k.key, weight: k.weight }));
			}
		}
	}

	const params = {
		account: manager.actor,
		permission: manager.permission,
		parent: 'active',
		auth: {
			threshold: 1,
			keys,
			accounts: [],
			waits: []
		}
	};
	return systemContract.action('updateauth', params);
}

export async function makeLinkAuthAction(manager: Session, action: string) {
	const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
	const params = {
		account: manager.actor,
		requirement: manager.permission,
		code: ANTELOPE_SYSTEM_CONTRACT,
		type: action
	};
	return systemContract.action('linkauth', params);
}

export async function makeDeleteAuthAction(manager: Session) {
	const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
	const params = {
		account: manager.actor,
		permission: manager.permission
	};
	return systemContract.action('deleteauth', params);
}

export async function makeUnlinkAuthAction(manager: Session, action: string) {
	const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
	const params = {
		account: manager.actor,
		code: ANTELOPE_SYSTEM_CONTRACT,
		type: action
	};
	return systemContract.action('unlinkauth', params);
}

export async function makeBuyRamBytesAction(manager: Session, receiver: NameType, bytes: Int64) {
	const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
	const params = {
		payer: manager.actor,
		receiver,
		bytes
	};
	return systemContract.action('buyrambytes', params);
}

export async function makeBuyRamBytesSelfAction(manager: Session) {
	return makeBuyRamBytesAction(
		manager,
		manager.actor,
		Int64.from(MANAGER_RAM_MINIMUM_KB).multiplying(1000)
	);
}
