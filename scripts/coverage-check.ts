// Read-only coverage check (3vhnkz): inventory == provider managed list, on-chain floors and
// app gates hold, and no lease can lapse within 6h without auto-renew covering it.
// It signs nothing and writes nothing on chain or on the provider.
// Usage: bun scripts/coverage-check.ts [--json] [--provider-file <file>] [rpc-url]
// --provider-file takes {"managed": [...], "serviceActive": true}; without it the provider
// is read over IAP SSH (service state and GET /v2/resource/manager/list).
// Exit 0 covered, 1 findings, 2 the check itself could not run.
import { APIClient } from '@wharfkit/antelope';

import { checkCoverage, type Observation, type ProviderState } from '../src/lib/coverage/check';
import { inventory } from '../src/lib/coverage/inventory';

const RPCS = ['https://jungle4.greymass.com', 'https://jungle4.cryptolions.io'];
const GCLOUD = process.env.GCLOUD ?? '/opt/homebrew/bin/gcloud';
const MARK = '__RP_PROVIDER__';
const REMOTE = `echo ${MARK} $(systemctl is-active resource-provider); curl -sS --fail -m 15 http://127.0.0.1:3002/v2/resource/manager/list`;

function readProvider(): ProviderState {
	const result = Bun.spawnSync(
		[GCLOUD, 'compute', 'ssh', 'buildflexity-app', '--project=buildflexity-app']
			.concat(['--zone=northamerica-northeast1-a', '--tunnel-through-iap', '--quiet'])
			.concat([`--command=${REMOTE}`]),
		{ timeout: 120_000 }
	);
	const lines = result.stdout.toString().split('\n');
	const at = lines.findIndex((line) => line.startsWith(MARK));
	if (at < 0) throw new Error(`could not reach the provider VM (exit ${result.exitCode})`);
	const state = lines[at].split(' ')[1];
	const body = lines.slice(at + 1).join('\n');
	if (!body.trim()) {
		// A stopped service cannot answer: say so, not "every account is unenrolled".
		throw new Error(`provider managed list unreadable (resource-provider.service is ${state})`);
	}
	const managed = JSON.parse(body);
	if (!Array.isArray(managed)) throw new Error('provider managed list is not a list');
	return { managed, serviceActive: state === 'active' };
}

async function call<T>(urls: string[], path: string, params: object): Promise<T> {
	let failure: unknown;
	for (const url of [...urls, ...urls]) {
		try {
			return (await new APIClient({ url }).call({
				path: path as `/${string}`,
				method: 'POST',
				params
			})) as T;
		} catch (error) {
			failure = error;
		}
	}
	throw failure;
}

async function observe(account: string, urls: string[]): Promise<Observation> {
	const data = await call<Observation['data']>(urls, '/v1/chain/get_account', {
		account_name: account
	});
	const orders = await call<{
		rows: (Observation['orders'][number] & { owner: string })[];
		more: boolean;
	}>(urls, '/v1/chain/get_table_rows', {
		json: true,
		code: 'eosio',
		scope: '0',
		table: 'powup.order',
		index_position: 2,
		key_type: 'name',
		lower_bound: account,
		upper_bound: account,
		limit: 1000
	});
	if (orders.more) throw new Error('lease table truncated');
	return { data, orders: orders.rows.filter((row) => row.owner === account) };
}

const args = process.argv.slice(2);
const fileAt = args.indexOf('--provider-file');
const url = args.find((arg) => arg.startsWith('http'));
try {
	const provider: ProviderState =
		fileAt >= 0 ? await Bun.file(args[fileAt + 1]).json() : readProvider();
	const observations = new Map<string, Observation>();
	for (const row of [...inventory.managed, ...inventory.selfManaged]) {
		try {
			observations.set(row.account, await observe(row.account, url ? [url] : RPCS));
		} catch (error) {
			console.error(`${row.account}: ${String(error).slice(0, 200)}`);
		}
	}
	if (!observations.size) throw new Error('no account could be read from the chain');
	const report = checkCoverage(inventory, provider, observations, Date.now());
	if (args.includes('--json')) {
		console.log(JSON.stringify({ at: new Date().toISOString(), ...report }));
	} else {
		console.table(report.accounts);
		for (const finding of report.findings) console.log(`FAIL ${finding.key}: ${finding.message}`);
		console.log(
			`${report.accounts.length} accounts read, ${provider.managed.length} managed by the provider, ${report.findings.length} finding(s)`
		);
	}
	process.exit(report.findings.length ? 1 : 0);
} catch (error) {
	console.error(`coverage check could not run: ${String(error)}`);
	process.exit(2);
}
