/**
 * Service entry point: `bun src/main.ts`.
 *
 * @packageDocumentation
 */
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { killProcess } from './shared/infrastructure/crash-fault-injector.ts';

const config = loadConfig();
const app = await createApp(config, { crash: killProcess });
await app.listen(config.port, '0.0.0.0');
