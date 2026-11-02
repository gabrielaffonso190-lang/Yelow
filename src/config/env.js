export function getRequiredEnv(name, env = process.env) {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getSnowflake(name, env) {
  const value = getRequiredEnv(name, env);

  if (!/^\d{17,20}$/.test(value)) {
    throw new Error(`Invalid Discord ID in environment variable: ${name}`);
  }

  return value;
}

export function getDiscordConfig(env = process.env) {
  return {
    token: getRequiredEnv('DISCORD_TOKEN', env),
  };
}

export function getDeployConfig(env = process.env) {
  const guildId = env.DISCORD_GUILD_ID?.trim();

  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    throw new Error('Invalid Discord ID in environment variable: DISCORD_GUILD_ID');
  }

  return {
    token: getRequiredEnv('DISCORD_TOKEN', env),
    clientId: getSnowflake('DISCORD_CLIENT_ID', env),
    guildId: guildId || undefined,
  };
}
