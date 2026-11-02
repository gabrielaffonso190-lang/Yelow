import assert from 'node:assert/strict';
import test from 'node:test';
import { getDeployConfig, getDiscordConfig, getRequiredEnv } from '../src/config/env.js';

test('getRequiredEnv trims configured values', () => {
  assert.equal(getRequiredEnv('DISCORD_TOKEN', { DISCORD_TOKEN: ' token ' }), 'token');
});

test('getRequiredEnv names a missing variable without exposing its value', () => {
  assert.throws(
    () => getRequiredEnv('DISCORD_TOKEN', {}),
    { message: 'Missing required environment variable: DISCORD_TOKEN' },
  );
});

test('getDiscordConfig requires only the bot token', () => {
  assert.deepEqual(getDiscordConfig({ DISCORD_TOKEN: 'token' }), { token: 'token' });
});

test('getDeployConfig validates the application ID and accepts an optional guild ID', () => {
  assert.deepEqual(
    getDeployConfig({
      DISCORD_TOKEN: 'token',
      DISCORD_CLIENT_ID: '12345678901234567',
      DISCORD_GUILD_ID: '98765432109876543',
    }),
    {
      token: 'token',
      clientId: '12345678901234567',
      guildId: '98765432109876543',
    },
  );
});

test('getDeployConfig rejects malformed Discord IDs', () => {
  assert.throws(
    () => getDeployConfig({ DISCORD_TOKEN: 'token', DISCORD_CLIENT_ID: 'invalid' }),
    { message: 'Invalid Discord ID in environment variable: DISCORD_CLIENT_ID' },
  );
});
