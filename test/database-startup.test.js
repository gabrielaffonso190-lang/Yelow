import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/services/db.js';

test('a fresh SQLite file gets the current schema and can be reopened without data loss', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vanta-db-'));
  const path = join(directory, 'vanta.sqlite');
  try {
    const db = openDatabase(path);
    const tables = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map(({ name }) => name));
    for (const table of [
      'products',
      'guild_config',
      'orders',
      'conversations',
      'missions',
      'payments',
    ]) {
      assert.ok(tables.has(table), `missing table ${table}`);
    }

    db.prepare(`
      INSERT INTO guild_config (guild_id, settings, staff_role_ids, updated_at)
      VALUES ('guild-1', '{"kept":true}', '[]', ?)
    `).run(new Date().toISOString());
    db.close();

    const reopened = openDatabase(path);
    assert.equal(
      reopened.prepare('SELECT settings FROM guild_config WHERE guild_id = ?')
        .get('guild-1').settings,
      '{"kept":true}',
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a partial existing database is rejected without being recreated or cleared', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vanta-db-partial-'));
  const path = join(directory, 'partial.sqlite');
  try {
    const original = new DatabaseSync(path);
    original.exec('CREATE TABLE preserved (value TEXT NOT NULL)');
    original.prepare('INSERT INTO preserved VALUES (?)').run('keep');
    original.close();

    assert.throws(() => openDatabase(path), /Database schema is incomplete/);
    const verified = new DatabaseSync(path, { readOnly: true });
    assert.equal(verified.prepare('SELECT value FROM preserved').get().value, 'keep');
    verified.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
