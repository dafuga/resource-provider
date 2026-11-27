// The checked-in inventory of every account our apps and games rely on (3vhnkz).
import data from '../../../deploy/jungle4-managed-accounts.json';

export const LIMIT_FIELDS = [
	'min_ms',
	'min_kb',
	'inc_ms',
	'inc_kb',
	'max_fee',
	'min_ram_kb',
	'inc_ram_kb',
	'ram_daily_max_fee'
] as const;

export type ManagedLimits = Record<(typeof LIMIT_FIELDS)[number], number | string>;

export interface InventoryRow extends ManagedLimits {
	account: string;
	role: string;
	usedBy: string;
	pays: { cpu_net: string; ram: string; players_ram?: string };
	// Hard CPU gates an app enforces on this account, on top of the provider floor.
	gates?: { cpu_us: number; source: string }[];
	// Where a signing key lives: a place and permission name only, never key material.
	authority: { permission: string; location: string }[];
}

export type Inventory = Omit<typeof data, 'managed'> & { managed: InventoryRow[] };

export const inventory = data as unknown as Inventory;
