import { randomUUID } from 'node:crypto';
import { getGuildSettings, writeAuditLog } from './db.js';
import { publishMission } from './missions.js';

const blogFeedUrl = 'https://discord.com/blog/rss.xml';
const maximumFeedBytes = 1_000_000;
const candidatePattern = /\bquests?\b/i;
const checkLockKey = 'discord-blog-feed';
let activeCheck;

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function readElement(xml, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escapedName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedName}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function readAttribute(xml, elementName, attributeName) {
  const element = xml.match(new RegExp(`<${elementName}\\b[^>]*>`, 'i'))?.[0] ?? '';
  const match = element.match(new RegExp(`\\b${attributeName}=["']([^"']+)["']`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function isDiscordBlogArticle(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname === 'discord.com'
      && url.pathname.startsWith('/blog/');
  } catch {
    return false;
  }
}

export function parseDiscordBlogFeed(xml) {
  if (typeof xml !== 'string' || xml.length > maximumFeedBytes || /<!DOCTYPE/i.test(xml)) {
    throw new Error('O feed do Discord Blog é inválido ou excedeu o limite de tamanho.');
  }

  const entries = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = readElement(item, 'title');
    const url = readElement(item, 'link');
    const summary = readElement(item, 'description');
    if (!title || !isDiscordBlogArticle(url) || !candidatePattern.test(`${title} ${summary}`)) {
      continue;
    }

    const publishedAt = readElement(item, 'pubDate');
    const parsedDate = publishedAt ? new Date(publishedAt) : null;
    const imageUrl = readAttribute(item, 'media:content', 'url')
      || readAttribute(item, 'enclosure', 'url');
    entries.push({
      externalId: readElement(item, 'guid') || url,
      title: title.slice(0, 256),
      url,
      summary: summary.slice(0, 2000),
      publishedAt: parsedDate && Number.isFinite(parsedDate.getTime())
        ? parsedDate.toISOString()
        : null,
      imageUrl: imageUrl.startsWith('https://') ? imageUrl.slice(0, 512) : null,
    });
  }
  return entries;
}

function recordSourceCheck(db, {
  sourceKey = 'discord_blog',
  now,
  intervalMinutes,
  status,
  entriesFound = 0,
  error = null,
}) {
  const nextCheckAt = new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
  db.prepare(`
    UPDATE mission_discovery_sources
    SET status = ?, last_checked_at = ?, next_check_at = ?,
      last_success_at = CASE WHEN ? = 'operational' THEN ? ELSE last_success_at END,
      last_error = ?, failure_count = failure_count + CASE WHEN ? = 'degraded' THEN 1 ELSE 0 END,
      entries_found = ?
    WHERE source_key = ?
  `).run(
    status,
    now.toISOString(),
    nextCheckAt,
    status,
    now.toISOString(),
    error,
    status,
    entriesFound,
    sourceKey,
  );
  return nextCheckAt;
}

async function fetchFeed(fetchImpl, timeoutMs) {
  const response = await fetchImpl(blogFeedUrl, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`O feed oficial respondeu HTTP ${response.status}.`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumFeedBytes) {
    throw new Error('O feed oficial excedeu o limite de tamanho.');
  }

  const body = await response.text();
  if (Buffer.byteLength(body) > maximumFeedBytes) {
    throw new Error('O feed oficial excedeu o limite de tamanho.');
  }
  return body;
}

async function runFeedCheck(db, {
  now,
  intervalMinutes,
  fetchImpl,
  timeoutMs,
}) {
  try {
    const xml = await fetchFeed(fetchImpl, timeoutMs);
    const entries = parseDiscordBlogFeed(xml);
    const insert = db.prepare(`
      INSERT INTO mission_discovery_entries (
        id, source_key, external_id, title, url, summary, published_at, image_url,
        status, first_seen_at, last_seen_at
      ) VALUES (?, 'discord_blog', ?, ?, ?, ?, ?, ?, 'review', ?, ?)
      ON CONFLICT(source_key, external_id) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        summary = excluded.summary,
        published_at = excluded.published_at,
        image_url = excluded.image_url,
        last_seen_at = excluded.last_seen_at,
        status = CASE
          WHEN mission_discovery_entries.title != excluded.title
            OR mission_discovery_entries.summary != excluded.summary
            OR mission_discovery_entries.image_url IS NOT excluded.image_url
          THEN 'review'
          ELSE mission_discovery_entries.status
        END
    `);
    for (const entry of entries) {
      const previous = db.prepare(`
        SELECT id, title, summary FROM mission_discovery_entries
        WHERE source_key = 'discord_blog' AND external_id = ?
      `).get(entry.externalId);
      if (previous
        && (previous.title !== entry.title || previous.summary !== entry.summary)) {
        db.prepare(`
          INSERT INTO mission_discovery_entry_history (
            entry_id, previous_title, previous_summary, next_title, next_summary, changed_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          previous.id,
          previous.title,
          previous.summary,
          entry.title,
          entry.summary,
          now.toISOString(),
        );
      }
      insert.run(
        randomUUID(),
        entry.externalId,
        entry.title,
        entry.url,
        entry.summary,
        entry.publishedAt,
        entry.imageUrl,
        now.toISOString(),
        now.toISOString(),
      );
    }

    const nextCheckAt = recordSourceCheck(db, {
      now,
      intervalMinutes,
      status: 'operational',
      entriesFound: entries.length,
    });
    return { checked: true, ok: true, candidateCount: entries.length, nextCheckAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao consultar o Discord Blog.';
    const nextCheckAt = recordSourceCheck(db, {
      now,
      intervalMinutes,
      status: 'degraded',
      error: message.slice(0, 300),
    });
    return { checked: true, ok: false, candidateCount: 0, nextCheckAt, error: message };
  }
}

export function getMissionDiscoveryStatus(db) {
  const sources = db.prepare(`
    SELECT source_key, source_name, source_url, access_mode, status,
      last_checked_at, next_check_at, last_success_at, last_error,
      failure_count, entries_found
    FROM mission_discovery_sources
    ORDER BY source_key
  `).all();
  const candidates = db.prepare(`
    SELECT id, title, url, summary, published_at, image_url, status, first_seen_at
    FROM mission_discovery_entries
    WHERE status = 'review'
    ORDER BY first_seen_at DESC LIMIT 10
  `).all();
  const candidateCount = db.prepare(`
    SELECT COUNT(*) AS count FROM mission_discovery_entries WHERE status = 'review'
  `).get().count;
  return { sources, candidates, candidateCount };
}

export function getEffectiveMissionDiscoveryInterval(db) {
  const rows = db.prepare('SELECT settings FROM guild_config').all();
  const intervals = rows.map(({ settings }) => {
    try {
      return JSON.parse(settings).missionDiscoveryIntervalMinutes;
    } catch {
      return null;
    }
  }).filter((value) => Number.isInteger(value) && value >= 15 && value <= 1440);
  return intervals.length ? Math.min(...intervals) : 60;
}

export async function checkMissionDiscoverySources({
  db,
  now = new Date(),
  intervalMinutes = 60,
  force = false,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440) {
    throw new RangeError('O intervalo de consulta deve estar entre 15 e 1.440 minutos.');
  }

  if (activeCheck) {
    return activeCheck;
  }

  const source = db.prepare(`
    SELECT next_check_at FROM mission_discovery_sources WHERE source_key = 'discord_blog'
  `).get();
  if (!force && source?.next_check_at && Date.parse(source.next_check_at) > now.getTime()) {
    return {
      checked: false,
      ok: true,
      nextCheckAt: source.next_check_at,
      ...getMissionDiscoveryStatus(db),
    };
  }

  activeCheck = runFeedCheck(db, { now, intervalMinutes, fetchImpl, timeoutMs });
  try {
    const result = await activeCheck;
    return { ...result, ...getMissionDiscoveryStatus(db) };
  } finally {
    activeCheck = undefined;
  }
}

async function publishVerifiedMissions({ client, db, guildId, settings, now }) {
  const channelId = settings.missionAnnouncementChannelId;
  if (!settings.missionAutomationEnabled
    || settings.missionRequireApproval !== false
    || !/^\d{17,20}$/.test(channelId ?? '')) {
    return { published: 0, failed: 0 };
  }

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()
    || !channel.isTextBased()
    || channel.guildId !== guildId) {
    throw new Error('O canal configurado para anúncios de Quests está indisponível.');
  }

  const verificationLimit = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const pending = db.prepare(`
    SELECT id FROM missions
    WHERE guild_id = ? AND status = 'active' AND ends_at > ?
      AND last_verified_at >= ?
      AND announcement_status != 'publishing'
      AND (
        announcement_status != 'published'
        OR updated_at > COALESCE(announcement_updated_at, '')
      )
    ORDER BY last_verified_at DESC LIMIT 20
  `).all(guildId, now.toISOString(), verificationLimit);

  let published = 0;
  let failed = 0;
  for (const mission of pending) {
    try {
      await publishMission({
        db,
        guild,
        actorId: client.user.id,
        questId: mission.id,
        channel,
        allowedRoleIds: settings.missionAllowedRoleIds ?? [],
      });
      writeAuditLog(db, guildId, client.user.id, 'mission.auto_announced', {
        missionId: mission.id,
        channelId,
      });
      published += 1;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`Falha ao publicar Quest verificada automaticamente (${errorName}).`);
      writeAuditLog(db, guildId, client.user.id, 'mission.auto_publish_failed', {
        missionId: mission.id,
        channelId,
        errorName,
      });
      failed += 1;
    }
  }
  return { published, failed };
}

export async function runMissionDiscoveryMaintenance({
  client,
  db,
  now = new Date(),
  fetchImpl = fetch,
}) {
  const configurations = db.prepare('SELECT guild_id, settings FROM guild_config').all();
  const intervalMinutes = getEffectiveMissionDiscoveryInterval(db);

  await checkMissionDiscoverySources({ db, now, intervalMinutes, fetchImpl });
  const guildResults = [];
  for (const row of configurations) {
    try {
      const settings = JSON.parse(row.settings);
      const result = await publishVerifiedMissions({
        client,
        db,
        guildId: row.guild_id,
        settings,
        now,
      });
      guildResults.push({ guildId: row.guild_id, ...result });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`Falha na automação de VANTA MISSIONS (${errorName}).`);
      writeAuditLog(db, row.guild_id, client.user.id, 'mission.auto_publish_failed', {
        errorName,
      });
      guildResults.push({ guildId: row.guild_id, published: 0, failed: 1, error: errorName });
    }
  }
  return { ...getMissionDiscoveryStatus(db), guildResults };
}

export function startMissionDiscovery({ client, db, intervalMs = 60_000 }) {
  const run = () => runMissionDiscoveryMaintenance({ client, db }).catch((error) => {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error(`Falha na consulta de fontes VANTA MISSIONS (${errorName}).`);
  });
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
