import { loadLocalDiscordToken } from './config/loadLocalEnv.js';

loadLocalDiscordToken();
await import('./index.js');
