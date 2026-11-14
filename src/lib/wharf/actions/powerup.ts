import { Asset, Int64, Name } from '@wharfkit/antelope';
import { PowerUpState, SampleUsage } from '@wharfkit/resources';

import { managerLog } from '$lib/logger';
import { objectify } from '$lib/utils';
import { ANTELOPE_SYSTEM_TOKEN } from 'src/config';

export interface AccountRequiredResources {
	cpuRequired: boolean;
	netRequired: boolean;
	ramRequired?: boolean;
}

export function getPowerupParamsCPU(
	ms: Int64,
	powerup: PowerUpState,
	sample: SampleUsage,
	requirements: AccountRequiredResources
) {
	const cpu_cost = Asset.from(0, ANTELOPE_SYSTEM_TOKEN);
	const cpu_frac = Int64.from(0);
	if (requirements.cpuRequired) {
		const cost = powerup.cpu.price_per_ms(sample, Number(ms));
		cpu_frac.add(powerup.cpu.frac_by_ms(sample, Number(ms)));
		cpu_cost.units.add(Asset.fromFloat(cost, ANTELOPE_SYSTEM_TOKEN).units);
	}
	return { cpu_cost, cpu_frac };
}

export function getPowerupParamsNET(
	kb: Int64,
	powerup: PowerUpState,
	sample: SampleUsage,
	requirements: AccountRequiredResources
) {
	const net_cost = Asset.from(0, ANTELOPE_SYSTEM_TOKEN);
	const net_frac = Int64.from(0);
	if (requirements.netRequired) {
		const cost = powerup.net.price_per_kb(sample, Number(kb));
		net_frac.add(powerup.net.frac_by_kb(sample, Number(kb)));
		net_cost.units.add(Asset.fromFloat(cost, ANTELOPE_SYSTEM_TOKEN).units);
	}
	return { net_cost, net_frac };
}

export function getPowerupParams(
	ms: Int64,
	kb: Int64,
	powerup: PowerUpState,
	sample: SampleUsage,
	requirements: AccountRequiredResources,
	payer: Name,
	receiver: Name,
	max_payment: Asset
) {
	const { cpu_cost, cpu_frac } = getPowerupParamsCPU(ms, powerup, sample, requirements);
	const { net_cost, net_frac } = getPowerupParamsNET(kb, powerup, sample, requirements);

	const params = {
		cpu_frac,
		net_frac,
		payer,
		receiver,
		days: 1,
		max_payment
	};

	managerLog.debug('Powerup Calculations', objectify({ params, costs: { cpu_cost, net_cost } }));

	return params;
}
