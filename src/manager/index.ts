import { Cron, type CronOptions } from 'croner';

import { getManagerContext } from './context';
import { manageAccountResources } from './manage/account';
import { manageManagerAccount } from './manage/manager';

import { managerLog } from '$lib/logger';
import { objectify } from '$lib/utils';
import { getManagerSession } from '$lib/wharf/session/manager';
import { ENABLE_RESOURCE_MANAGER, MANAGER_CRONJOB } from 'src/config';

const cron = MANAGER_CRONJOB;
const cronOptions: CronOptions = { catch: (e) => managerLog.error(e), protect: true };

export const managerJob = async function () {
	try {
		const manager = await getManagerSession();
		const managerContext = await getManagerContext();
		await manageManagerAccount(manager, managerContext);
		if (!managerContext.managedAccounts.length) {
			managerLog.info(
				'Manager skipped because no managed accounts found. Add accounts using the "manager add" command or through the API.'
			);
			return;
		}
		for (const account of managerContext.managedAccounts) {
			managerLog.debug('Running resource management', objectify({ account }));
			await manageAccountResources(manager, account, managerContext);
		}
	} catch (error) {
		managerLog.error('managerJob failed', { error: String(error) });
	}
};

export async function manager() {
	if (!ENABLE_RESOURCE_MANAGER) {
		managerLog.info(
			'Resource Manager Service is disabled. Set ENABLE_RESOURCE_MANAGER=true if you wish to run this service.'
		);
		return;
	}

	managerLog.info('Resource Manager Service starting', { cron, cronOptions });
	// Run immediately
	managerJob();

	// Schedule the cron job
	new Cron(cron, cronOptions, managerJob);
}
