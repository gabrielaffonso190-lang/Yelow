import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const loaderPath = fileURLToPath(new URL('../src/config/loadLocalEnv.js', import.meta.url));

function runLoader(directory, inheritedToken) {
  const script = `
    import { loadLocalDiscordToken } from ${JSON.stringify(loaderPath)};
    loadLocalDiscordToken();
    console.log(process.env.DISCORD_TOKEN === 'local-test-token' ? 'local' : 'inherited');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, DISCORD_TOKEN: inheritedToken },
  });
}

test('local .env token takes precedence for npm start without printing token values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vanta-env-'));
  try {
    writeFileSync(join(directory, '.env'), 'DISCORD_TOKEN=local-test-token\n');
    const result = runLoader(directory, 'inherited-test-token');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'local');
    assert.doesNotMatch(result.stdout + result.stderr, /local-test-token|inherited-test-token/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime Secret is used when there is no local .env file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vanta-env-'));
  try {
    const result = runLoader(directory, 'inherited-test-token');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'inherited');
    assert.doesNotMatch(result.stdout + result.stderr, /inherited-test-token/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
