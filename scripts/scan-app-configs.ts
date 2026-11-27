// Fails when any app repository names a chain account that is not in the inventory.
// Reads each repository's default branch through a shallow bare clone made with the caller's
// git credentials. A repository that cannot be read fails the run: unread is not clean.
// Usage: bun scripts/scan-app-configs.ts [--cache <dir>]
// Exit 0 clean, 1 unknown account(s), 2 a repository could not be read.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { inventory } from '../src/lib/coverage/inventory';
import { type AppFile, findUnknownAccounts, isScannedFile } from '../src/lib/coverage/scan';

const flag = process.argv.indexOf('--cache');
const cache =
	flag > 0 ? process.argv[flag + 1] : join(homedir(), '.cache', 'rp-coverage', 'app-repos');

function git(args: string[]) {
	const result = Bun.spawnSync(['git', '-c', 'core.askPass=false', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 180_000
	});
	if (!result.success) {
		throw new Error(`git ${args.join(' ')}: ${String(result.stderr).trim().slice(0, 300)}`);
	}
	return String(result.stdout);
}

function retry(read: () => void, attempts = 5) {
	for (let attempt = 1; ; attempt++) {
		try {
			return read();
		} catch (error) {
			if (attempt >= attempts) throw error;
			Bun.sleepSync(attempt * 2000);
		}
	}
}

function readRepo(repo: string): AppFile[] {
	const dir = join(cache, `${repo.split('/')[1]}.git`);
	const url = `https://github.com/${repo}.git`;
	if (!existsSync(dir)) retry(() => git(['clone', '-q', '--depth', '1', '--bare', url, dir]));
	// Under launchd the credential helper fails now and then, so the network read is retried.
	retry(() => git(['-C', dir, 'fetch', '-q', '--depth', '1', url, 'HEAD']));
	return git(['-C', dir, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD'])
		.split('\n')
		.filter(isScannedFile)
		.map((path) => ({ repo, path, content: git(['-C', dir, 'show', `FETCH_HEAD:${path}`]) }));
}

mkdirSync(cache, { recursive: true });
const files: AppFile[] = [];
const unreadable: string[] = [];
for (const repo of inventory.appRepos) {
	try {
		files.push(...readRepo(repo));
	} catch (error) {
		unreadable.push(`${repo}: ${String(error)}`);
	}
}
const unknown = findUnknownAccounts(inventory, files);
for (const [name, places] of unknown) {
	console.log(`UNKNOWN ${name}: ${places.slice(0, 5).join(', ')}`);
}
for (const line of unreadable) console.log(`UNREADABLE ${line}`);
console.log(
	`scanned ${files.length} files in ${inventory.appRepos.length - unreadable.length}/${inventory.appRepos.length} app repositories; ${unknown.size} account(s) missing from the inventory`
);
process.exit(unreadable.length ? 2 : unknown.size ? 1 : 0);
