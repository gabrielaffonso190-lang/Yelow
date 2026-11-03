import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { missionsCommand } from '../src/commands/missions.js';
import { ensureMissionSchema } from '../src/services/db.js';
import { configurationSection } from '../src/services/ui.js';

test('Config Center exposes Quest channel, automation, approval, interval, mention, preview, and source controls', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}',
      staff_role_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  ensureMissionSchema(db);
  const panel = configurationSection(db, 'guild-1', 'missions');
  const componentIds = panel.components.flatMap((row) => row.components
    .map((component) => component.data.custom_id));

  assert.ok(componentIds.includes('cfg:channel:missionAnnouncementChannelId'));
  assert.ok(componentIds.includes('cfg:mission:auto'));
  assert.ok(componentIds.includes('cfg:mission:approval'));
  assert.ok(componentIds.includes('cfg:mission:interval'));
  assert.ok(componentIds.includes('cfg:mission:mentions'));
  assert.ok(componentIds.includes('cfg:mission:preview'));
  assert.ok(componentIds.includes('cfg:mission:check'));
  const description = panel.embeds[0].toJSON().fields
    .find((field) => field.name === 'Fontes e verificação').value;
  assert.match(description, /Discord Discover/);
  assert.match(description, /Discord Newsroom/);
  assert.match(description, /Discord Blog/);
  db.close();
});

test('Quest slash command includes manual sources, discovery, and a private visual preview', () => {
  const subcommands = missionsCommand.data.toJSON().options.map((option) => option.name);
  assert.ok(subcommands.includes('fontes'));
  assert.ok(subcommands.includes('descobrir'));
  assert.ok(subcommands.includes('teste'));
});
