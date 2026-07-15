import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import type { ElysiaSwaggerConfig } from '@elysiajs/swagger';
import { Elysia } from 'elysia';
import { BunAdapter } from 'elysia/adapter/bun';

import { generalLog } from '$lib/logger';
import { ENABLE_RESOURCE_MANAGER, ENABLE_RESOURCE_PROVIDER, SERVICE_HTTP_PORT } from 'src/config';

const port = SERVICE_HTTP_PORT || 3000;

const swaggerConfig: ElysiaSwaggerConfig = {
	documentation: {
		info: {
			title: 'Resource Provider APIs',
			description: 'API documentation for Resource Provider services',
			version: '0.0.0'
		},
		security: [{ bearerAuth: [] }],
		components: {
			securitySchemes: {
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'string',
					description: 'Enter Bearer token **_only_**'
				}
			}
		},
		tags: [
			...(ENABLE_RESOURCE_PROVIDER
				? [
						{
							name: 'Resource Provider (v2)',
							description: 'Resource Provider endpoints to publicly offer resources to users.'
						},
						{
							name: 'Resource Provider (v1)',
							description: 'Legacy Resource Provider endpoints'
						}
					]
				: []),
			...(ENABLE_RESOURCE_MANAGER
				? [
						{
							name: 'Resource Manager',
							description:
								'Resource Management endpoints for resource automation (requires Bearer token)'
						}
					]
				: [])
		]
	},
	swaggerOptions: {
		persistAuthorization: true
	}
};

let app: Elysia | null = null;
let started = false;

export function getApp(): Elysia {
	if (!app) {
		app = new Elysia({
			adapter: BunAdapter,
			aot: true
		});
		app.use(cors({ origin: true }));
		app.use(swagger(swaggerConfig));
		app.onError((context) => {
			switch (context.code) {
				case 'VALIDATION':
					return context.status(400, {
						code: 400,
						message: String(context.error),
						all: context.error.all
					});
				default:
					return context.status(400, {
						code: 400,
						message: String(context.error)
					});
			}
		});
	}
	return app;
}

export function startApp(): Elysia {
	if (started) return getApp();
	started = true;
	const instance = getApp();
	instance.listen(SERVICE_HTTP_PORT);
	generalLog.info(`HTTP server running on http://localhost:${port}`);
	return instance;
}
