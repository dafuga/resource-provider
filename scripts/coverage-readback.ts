// Read-only check that every account in deploy/jungle4-managed-accounts.json is above its
// floor on the live chain, and what a full refill of each would cost if it were drained.
// Usage: bun scripts/coverage-readback.ts [rpc-url]
import { APIClient } from '@wharfkit/antelope';
import { Resources } from '@wharfkit/resources';

import inventory from '../deploy/jungle4-managed-accounts.json';

const url = process.argv[2] ?? 'https://jungle4.greymass.com';
const client = new APIClient({ url });
const resources = new Resources({ api: client });
const sample = await resources.getSampledUsage();
const powerup = await resources.v1.powerup.get_state();

let low = 0;
let refillTotal = 0;
const rows = [];
for (const row of inventory.managed) {
	const data = await client.v1.chain.get_account(row.account);
	const cpu = Number(data.cpu_limit.max) - Number(data.cpu_limit.current_used);
	const net = Number(data.net_limit.max) - Number(data.net_limit.current_used);
	const ram = Number(data.ram_quota) - Number(data.ram_usage);
	const ok =
		cpu >= row.min_ms * 1000 &&
		net >= row.min_kb * 1000 &&
		(row.inc_ram_kb === 0 || ram >= row.min_ram_kb * 1000);
	// Drained: the manager buys the increment plus the whole floor.
	const refill =
		powerup.cpu.price_per_ms(sample, row.min_ms + row.inc_ms) +
		powerup.net.price_per_kb(sample, row.min_kb + row.inc_kb);
	refillTotal += refill;
	if (!ok) low++;
	rows.push({
		account: row.account,
		cpu_us: cpu,
		floor_us: row.min_ms * 1000,
		net_b: net,
		ram_free: ram,
		liquid: String(data.core_liquid_balance ?? '0.0000 EOS'),
		status: ok ? 'OK' : 'BELOW FLOOR',
		drained_refill_eos: refill.toFixed(4),
		within_max_fee: refill <= Number(row.max_fee.split(' ')[0]) ? 'yes' : 'NO'
	});
}
console.table(rows);
const payer = await client.v1.chain.get_account(inventory.selfManaged[0].account);
console.log(
	`payer ${inventory.selfManaged[0].account}: ${payer.core_liquid_balance}; refilling every drained account at once costs ${refillTotal.toFixed(4)} EOS; ${low} account(s) below floor`
);
process.exit(low ? 1 : 0);
