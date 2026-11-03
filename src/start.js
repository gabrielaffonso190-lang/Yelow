import { loadLocalDiscordToken } from './config/loadLocalEnv.js';
import { logError } from './utils/errorLogging.js';

try {
  loadLocalDiscordToken();
  await import('./index.js');
} catch (error) {
  logError('Não foi possível carregar ou iniciar a VANTA.', error);
  process.exitCode = 1;
}
