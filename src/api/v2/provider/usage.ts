import { usageDatabase } from '$lib/db/models/provider/usage';
import { getInt, getSetting } from '$lib/settings';

export async function usage({ params }: { params: { account: string } }) {
	const currentUsage = await usageDatabase.getUsage(params.account);
	const limitMs = getSetting('provider.free_transactions.limit_ms');
	const limitKb = getSetting('provider.free_transactions.limit_kb');

	return {
		account: params.account,
		usage: {
			cpu: currentUsage.cpu,
			net: currentUsage.net
		},
		quota: {
			cpu: typeof limitMs === 'number' ? limitMs * 1000 : null,
			net: typeof limitKb === 'number' ? limitKb * 1000 : null
		},
		window: {
			hours: getInt('provider.usage.window_hours')
		}
	};
}
