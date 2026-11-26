// Finds the chain accounts an app names in its config files, so a new one that is missing
// from the inventory fails the test instead of running out of resources later (3vhnkz).
import type { Inventory } from './inventory';

// Deployment config: wrangler files and env files.
const CONFIG_FILE = /(^|\/)(wrangler[^/]*\.(toml|jsonc?)|\.env(\.[A-Za-z0-9_-]+)*)$/;
// Source that configures accounts (contract names, payers, keepers, sponsor game lists).
const SOURCE_FILE = /^(src|keeper|workers|scripts)\/.*\.(ts|js|mjs|json|svelte)$/;
const SKIPPED =
	/(^|\/)(node_modules|test|tests|e2e|fixtures|dist|build)\/|\.(test|spec)\.|\.test-helpers\./;

const ACCOUNT = /^(?=.*[a-z])[a-z1-5.]{1,12}$/;
// Any *.gm name, wherever it appears, unless part of a longer word, path or hostname.
const GM_NAME = /(?<![A-Za-z0-9._/-])([a-z1-5.]{1,9}\.gm)(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;
// `KEY = "value"` lines whose key says the value is an account (catches non-.gm names).
const ASSIGNMENT =
	/^\s*["']?[A-Z0-9_]*(?:ACCOUNT|CONTRACT|ACTOR|PAYER|SPONSOR|COSIGNER|TREASURY)["']?\s*[=:]\s*["']?([a-z1-5.]+(?:@[a-z1-5.]+)?)["']?\s*,?\s*(?:#.*)?$/;

// Chain system accounts and template placeholders; none of them is ours to keep resourced.
const NOT_OURS = /^(eosio(\..*)?|core\.vaulta|true|false|youraccount|yourcontract|myaccount)$/;

export const isConfigFile = (path: string) => CONFIG_FILE.test(path);

export function isScannedFile(path: string) {
	return isConfigFile(path) || (SOURCE_FILE.test(path) && !SKIPPED.test(path));
}

export function findAccounts(path: string, content: string): string[] {
	const found = new Set<string>();
	for (const line of content.split('\n')) {
		for (const match of line.matchAll(GM_NAME)) found.add(match[1]);
		if (!isConfigFile(path)) continue;
		const value = ASSIGNMENT.exec(line)?.[1].split('@')[0];
		if (value && ACCOUNT.test(value)) found.add(value);
	}
	return [...found].filter((name) => !NOT_OURS.test(name));
}

export function knownNames(inventory: Inventory): Set<string> {
	return new Set(
		[...inventory.managed, ...inventory.selfManaged, ...inventory.notManaged].map(
			(row) => row.account
		)
	);
}

export interface AppFile {
	repo: string;
	path: string;
	content: string;
}

export function findUnknownAccounts(inventory: Inventory, files: AppFile[]) {
	const known = knownNames(inventory);
	const examples = new Set(inventory.exampleNames.map((row) => row.name));
	const unknown = new Map<string, string[]>();
	for (const file of files) {
		if (!isScannedFile(file.path)) continue;
		for (const name of findAccounts(file.path, file.content)) {
			// An example name is only excused in source; in deployment config it is real.
			if (known.has(name) || (examples.has(name) && !isConfigFile(file.path))) continue;
			unknown.set(name, [...(unknown.get(name) ?? []), `${file.repo}:${file.path}`]);
		}
	}
	return unknown;
}
