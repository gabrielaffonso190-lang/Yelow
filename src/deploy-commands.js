import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';
import { getDeployConfig } from './config/env.js';
import { loadLocalDiscordToken } from './config/loadLocalEnv.js';

loadLocalDiscordToken();

async function main() {
  const { token, clientId, guildId } = getDeployConfig();
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  const body = commands.map((command) => command.data.toJSON());

  await rest.put(route, { body });
  console.log(`Comandos da VANTA registrados (${guildId ? 'servidor' : 'global'}).`);
}

main().catch((error) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(`Não foi possível registrar os comandos (${errorName}).`);
  process.exitCode = 1;
});
