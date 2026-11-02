import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChannelType } from 'discord.js';
import { ensureMissionSchema } from '../src/services/db.js';
import {
  configureMissionAlerts,
  createMission,
  listMissions,
  MissionError,
  publishMission,
  runMissionMaintenance,
  setMissionStatus,
  updateMission,
} from '../src/services/missions.js';

function createDatabase() {
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
  return db;
}

function missionInput(overrides = {}) {
  return {
    name: 'Official Quest',
    promotedContent: 'Example Game',
    questType: 'play',
    requirements: 'Play for 15 minutes.',
    reward: 'Confirmed avatar item.',
    endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    platforms: 'Windows, macOS',
    officialUrl: 'https://discord.com/quests/123',
    sourceUrl: 'https://discord.com/blog/example',
    ...overrides,
  };
}

test('missions store manual source verification and only list active non-expired quests', () => {
  const db = createDatabase();
  const quest = createMission(db, 'guild-1', 'admin-1', missionInput());

  assert.equal(quest.status, 'active');
  assert.equal(quest.quest_type, 'play');
  assert.ok(quest.last_verified_at);
  assert.deepEqual(listMissions(db, 'guild-1').map(({ id }) => id), [quest.id]);

  const updated = updateMission(db, 'guild-1', 'admin-2', quest.id, {
    reward: 'Updated confirmed reward.',
    sourceUrl: 'https://discord.com/blog/updated',
  });
  assert.equal(updated.reward, 'Updated confirmed reward.');
  assert.equal(updated.updated_by, 'admin-2');
  assert.ok(Date.parse(updated.last_verified_at) >= Date.parse(quest.last_verified_at));

  const ended = setMissionStatus(db, 'guild-1', 'admin-1', quest.id, 'unavailable');
  assert.equal(ended.status, 'unavailable');
  assert.equal(listMissions(db, 'guild-1').length, 0);
  assert.equal(listMissions(db, 'guild-1', { includeInactive: true }).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 3);
  db.close();
});

test('missions reject unverified, unsafe, incomplete, and expired quest data', () => {
  const db = createDatabase();

  assert.throws(
    () => createMission(db, 'guild-1', 'admin-1', missionInput({
      officialUrl: null,
      instructions: null,
    })),
    MissionError,
  );
  assert.throws(
    () => createMission(db, 'guild-1', 'admin-1', missionInput({
      sourceUrl: 'javascript:alert(1)',
    })),
    MissionError,
  );
  assert.throws(
    () => createMission(db, 'guild-1', 'admin-1', missionInput({
      endsAt: new Date(Date.now() - 60_000).toISOString(),
    })),
    /encerramento futuro/,
  );
  db.close();
});

test('mission announcements include verified details, banner, and the Discord button', async () => {
  const db = createDatabase();
  const quest = createMission(db, 'guild-1', 'admin-1', missionInput({
    officialUrl: null,
    instructions: 'Abra Discord > Inventário > Quests.',
    bannerUrl: 'https://cdn.discordapp.com/quest-banner.png',
  }));
  const sent = [];
  const edits = [];
  const message = {
    id: 'message-1',
    url: 'https://discord.com/channels/guild-1/message-1',
    edit: async (payload) => edits.push(payload),
  };
  const channel = {
    id: 'channel-1',
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    isSendable: () => true,
    messages: { fetch: async () => message },
    send: async (payload) => {
      sent.push(payload);
      return message;
    },
  };

  const result = await publishMission({
    db,
    guild: { id: 'guild-1' },
    actorId: 'admin-1',
    questId: quest.id,
    channel,
  });
  assert.equal(result.updated, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].toJSON().fields[3].value, /Play for 15 minutes/);
  assert.equal(sent[0].embeds[0].toJSON().image.url, 'https://cdn.discordapp.com/quest-banner.png');
  assert.equal(
    sent[0].components[0].toJSON().components[0].custom_id,
    `missions:view:${quest.id}`,
  );

  await publishMission({
    db,
    guild: { id: 'guild-1' },
    actorId: 'admin-1',
    questId: quest.id,
    channel,
  });
  assert.equal(sent.length, 1);
  assert.equal(edits.length, 1);
  db.close();
});

test('mission maintenance expires quests and sends one configured close reminder', async () => {
  const db = createDatabase();
  const expired = createMission(db, 'guild-1', 'admin-1', missionInput({
    name: 'Expired Quest',
    endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  }));
  const reminder = createMission(db, 'guild-1', 'admin-1', missionInput({
    name: 'Closing Soon',
    endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  }));
  const now = new Date();
  const expiredAt = new Date(now.getTime() - 60_000).toISOString();
  db.prepare('UPDATE missions SET ends_at = ? WHERE id = ?').run(expiredAt, expired.id);
  configureMissionAlerts(db, 'guild-1', 'admin-1', 'alerts-1');
  const sent = [];
  const channel = {
    guildId: 'guild-1',
    isTextBased: () => true,
    isSendable: () => true,
    send: async (payload) => sent.push(payload),
  };
  const client = {
    user: { id: 'bot-1' },
    channels: { fetch: async () => channel },
  };

  await runMissionMaintenance({ client, db, now });
  assert.equal(db.prepare('SELECT status FROM missions WHERE id = ?').get(expired.id).status, 'ended');
  assert.ok(db.prepare('SELECT alert_sent_at FROM missions WHERE id = ?').get(reminder.id).alert_sent_at);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].toJSON().title, /perto do encerramento/);
  await runMissionMaintenance({ client, db, now });
  assert.equal(sent.length, 1);
  db.close();
});
