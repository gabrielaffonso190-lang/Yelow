import { existsSync } from 'node:fs';

export function loadLocalDiscordToken() {
  if (!existsSync('.env')) {
    return;
  }

  const inheritedToken = process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_TOKEN;
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (inheritedToken !== undefined) {
      process.env.DISCORD_TOKEN = inheritedToken;
    }
    throw error;
  }

  if (!process.env.DISCORD_TOKEN?.trim() && inheritedToken !== undefined) {
    process.env.DISCORD_TOKEN = inheritedToken;
  }
}
