import { createMockFetch } from './mock-fetch';

import { configDatabase } from '$lib/db/models/config';
import { runMigrations } from '$lib/db/migrate';

const originalFetch = globalThis.fetch;
globalThis.fetch = createMockFetch(originalFetch) as typeof globalThis.fetch;

runMigrations();
configDatabase.set('provider.free_transactions.limit_ms', '5');
configDatabase.set('provider.free_transactions.limit_kb', '10');
