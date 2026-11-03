import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChannelType } from 'discord.js';
import { ensureMissionSchema } from '../src/services/db.js';
import {
  checkMissionDiscoverySources,
  getMissionDiscoveryStatus,
  parseDiscordBlogFeed,
  runMissionDiscoveryMaintenance,
} from '../src/services/missionDiscovery.js';
import { createMission, updateMission } from '../src/services/missions.js';

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

const feed = `<?xml version="1.0"?>
  <rss><channel><item>
    <title>New Discord Quest: Example Game</title>
    <link>https://discord.com/blog/example-quest</link>
    <guid>https://discord.com/blog/example-quest</guid>
    <description>Official update about a video Quest.</description>
    <pubDate>Mon, 02 Nov 2026 00:00:00 GMT</pubDate>
    <media:content url="https://cdn.discordapp.com/quest-banner.png"/>
  </item><item>
    <title>General Discord update</title>
    <link>https://discord.com/blog/general-update</link>
    <description>No campaign metadata.</description>
  </item></channel></rss>`;

test('official Blog feed discovery records Quest candidates and deduplicates on restart', async () => {
  const db = createDatabase();
  let currentFeed = feed;
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://discord.com/blog/rss.xml');
    return new Response(currentFeed, {
      headers: { 'content-type': 'application/rss+xml' },
    });
  };
  const now = new Date('2026-11-03T00:00:00Z');

  const first = await checkMissionDiscoverySources({
    db,
    now,
    force: true,
    intervalMinutes: 30,
    fetchImpl,
  });
  const second = await checkMissionDiscoverySources({
    db,
    now: new Date(now.getTime() + 60_000),
    force: true,
    intervalMinutes: 30,
    fetchImpl,
  });

  assert.equal(first.ok, true);
  assert.equal(first.candidateCount, 1);
  assert.equal(second.candidateCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mission_discovery_entries').get().count, 1);
  assert.equal(first.candidates[0].status, 'review');
  assert.equal(first.candidates[0].url, 'https://discord.com/blog/example-quest');
  assert.equal(first.sources.find((source) => source.source_key === 'discord_blog').status, 'operational');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM missions').get().count, 0);

  currentFeed = feed
    .replace('New Discord Quest: Example Game', 'Updated Discord Quest: Example Game')
    .replace('Official update about a video Quest.', 'Updated official Quest announcement.');
  await checkMissionDiscoverySources({
    db,
    now: new Date(now.getTime() + 120_000),
    force: true,
    intervalMinutes: 30,
    fetchImpl,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mission_discovery_entries').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mission_discovery_entry_history').get().count, 1);
  assert.equal(db.prepare('SELECT status FROM mission_discovery_entries').get().status, 'review');
  const imported = createMission(db, 'guild-1', 'admin-1', {
    name: 'Manually verified Quest',
    promotedContent: 'Example Game',
    questType: 'video',
    requirements: 'Requirements checked against the promotion.',
    reward: 'Reward confirmed by the team.',
    endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    platforms: 'Windows',
    instructions: 'Open Discord > Quests.',
    sourceUrl: 'https://discord.com/blog/example-quest',
  });
  assert.equal(imported.source_name, 'Discord Blog');
  assert.equal(imported.source_published_at, '2026-11-02T00:00:00.000Z');
  assert.equal(db.prepare('SELECT status FROM mission_discovery_entries').get().status, 'imported');
  db.close();
});

test('Quest feed parsing rejects non-Discord links and source failures remain recorded', async () => {
  const parsed = parseDiscordBlogFeed(feed.replace(
    'https://discord.com/blog/example-quest',
    'https://example.test/quest',
  ));
  assert.equal(parsed.length, 0);

  const db = createDatabase();
  const result = await checkMissionDiscoverySources({
    db,
    force: true,
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
  const sources = getMissionDiscoveryStatus(db).sources;
  assert.equal(sources.find((source) => source.source_key === 'discord_blog').failure_count, 1);
  assert.equal(sources.find((source) => source.source_key === 'discord_discover_quests').status, 'manual');
  assert.equal(sources.find((source) => source.source_key === 'discord_newsroom').status, 'manual');
  db.close();
});

test('automatic publishing respects review settings, updates the original, and does not duplicate posts', async () => {
  const db = createDatabase();
  const guildId = 'guild-1';
  const channelId = '12345678901234567';
  const settings = {
    missionAutomationEnabled: true,
    missionRequireApproval: true,
    missionAnnouncementChannelId: channelId,
    missionAllowedRoleIds: [],
  };
  db.prepare(`
    INSERT INTO guild_config (guild_id, settings, staff_role_ids, updated_at)
    VALUES (?, ?, '[]', ?)
  `).run(guildId, JSON.stringify(settings), new Date().toISOString());
  const quest = createMission(db, guildId, 'admin-1', {
    name: 'Verified Quest',
    promotedContent: 'Example Game',
    questType: 'play',
    requirements: 'Complete an official game task.',
    reward: 'Confirmed in the official promotion.',
    endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    platforms: 'Windows',
    officialUrl: 'https://discord.com/quests/123',
    sourceUrl: 'https://discord.com/blog/example-quest',
  });
  const sent = [];
  const edits = [];
  const message = {
    id: 'announcement-1',
    url: 'https://discord.com/channels/guild-1/announcement-1',
    edit: async (payload) => edits.push(payload),
  };
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    isSendable: () => true,
    messages: { fetch: async () => message },
    send: async (payload) => {
      sent.push(payload);
      return message;
    },
  };
  const guild = {
    id: guildId,
    channels: { fetch: async () => channel },
  };
  const client = {
    user: { id: 'bot-1' },
    guilds: {
      cache: new Map([[guildId, guild]]),
      fetch: async () => guild,
    },
    channels: { fetch: async () => channel },
  };
  const fetchImpl = async () => new Response('<rss><channel></channel></rss>', {
    headers: { 'content-type': 'application/rss+xml' },
  });

  await runMissionDiscoveryMaintenance({ client, db, fetchImpl });
  assert.equal(sent.length, 0);
  settings.missionRequireApproval = false;
  db.prepare('UPDATE guild_config SET settings = ? WHERE guild_id = ?')
    .run(JSON.stringify(settings), guildId);
  await runMissionDiscoveryMaintenance({ client, db, fetchImpl });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].toJSON().footer.text, 'VANTA — Technology without limits.');

  await runMissionDiscoveryMaintenance({
    client,
    db,
    now: new Date(Date.now() + 2_000),
    fetchImpl,
  });
  assert.equal(sent.length, 1);

  updateMission(db, guildId, 'admin-1', quest.id, {
    reward: 'Updated and verified reward.',
  });
  await runMissionDiscoveryMaintenance({
    client,
    db,
    now: new Date(Date.now() + 3_000),
    fetchImpl,
  });
  assert.equal(sent.length, 1);
  assert.equal(edits.length, 1);
  assert.match(edits[0].embeds[0].toJSON().fields[1].value, /Updated and verified reward/);
  db.close();
});
