/**
 * Service entry point: `bun src/main.ts`.
 *
 * @packageDocumentation
 */
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
