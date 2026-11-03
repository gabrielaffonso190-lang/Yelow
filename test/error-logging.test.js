import assert from 'node:assert/strict';
import test from 'node:test';
import { logError } from '../src/utils/errorLogging.js';

test('startup error logging includes diagnostics and redacts configured secrets', () => {
  const output = [];
  const token = 'discord-token-value';
  const apiKey = 'huehue-api-key-value';
  const error = new Error(`Login failed with Bearer ${apiKey}; token=${token}`);
  const logger = { error: (message) => output.push(message) };

  logError('Startup failed', error, {
    env: { DISCORD_TOKEN: token, HUEHUE_API_KEY: apiKey },
    logger,
  });

  assert.equal(output.length, 1);
  assert.match(output[0], /Startup failed/);
  assert.match(output[0], /"name": "Error"/);
  assert.match(output[0], /"message":/);
  assert.match(output[0], /"stack":/);
  assert.match(output[0], /Bearer \[REDACTED\]/);
  assert.doesNotMatch(output[0], /discord-token-value|huehue-api-key-value/);
});

test('non-Error startup failures are still reported safely', () => {
  const output = [];
  logError('Startup failed', 'unexpected rejection', {
    env: {},
    logger: { error: (message) => output.push(message) },
  });

  assert.match(output[0], /"name": "UnknownError"/);
  assert.match(output[0], /"message": "unexpected rejection"/);
});
