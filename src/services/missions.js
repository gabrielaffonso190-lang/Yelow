import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { BRAND, withBrandSignature } from '../config/brand.js';
import {
  getGuildSettings,
  updateGuildSettings,
  withTransaction,
  writeAuditLog,
} from './db.js';
import { isAdmin } from './permissions.js';

const maximumFieldLength = 1000;
const reminderWindowMs = 24 * 60 * 60 * 1000;
const missingAlertChannelWarnings = new Set();
const discordAppUrl = 'https://discord.com/app';

export class MissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissionError';
  }
}

function validateHttpsUrl(rawUrl, label, maximumLength = 512) {
  if (typeof rawUrl !== 'string' || rawUrl.length > maximumLength) {
    throw new MissionError(`${label} deve ser um link HTTPS válido.`);
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MissionError(`${label} deve ser um link HTTPS válido.`);
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new MissionError(`${label} deve ser um link HTTPS válido.`);
  }

  return url.toString();
}

function validateText(value, label, maximumLength = maximumFieldLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw new MissionError(`${label} é obrigatório e aceita até ${maximumLength} caracteres.`);
  }
  return value.trim();
}

function validateEndDate(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new MissionError('Informe o encerramento com data, hora e fuso, por exemplo 2026-12-31T23:59-03:00.');
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new MissionError('A data de encerramento é inválida.');
  }

  const isoDate = new Date(timestamp).toISOString();
  if (timestamp <= Date.now()) {
    throw new MissionError('A Quest já terminou; informe um encerramento futuro.');
  }

  return isoDate;
}

function validateQuest(data) {
  const questType = data.questType;
  if (!['play', 'video'].includes(questType)) {
    throw new MissionError('O tipo deve ser Play Quest ou Video Quest.');
  }

  const officialUrl = data.officialUrl
    ? validateHttpsUrl(data.officialUrl, 'O link oficial')
    : null;
  const instructions = data.instructions
    ? validateText(data.instructions, 'A instrução para encontrar a Quest')
    : null;

  if (!officialUrl && !instructions) {
    throw new MissionError('Informe o link oficial ou instruções para encontrar a Quest no Discord.');
  }

  return {
    name: validateText(data.name, 'O nome da Quest', 100),
    promotedContent: validateText(data.promotedContent, 'O jogo ou conteúdo promovido', 100),
    questType,
    requirements: validateText(data.requirements, 'Os requisitos'),
    reward: validateText(data.reward, 'A recompensa oficial', 300),
    endsAt: validateEndDate(data.endsAt),
    platforms: validateText(data.platforms, 'As plataformas compatíveis', 200),
    officialUrl,
    instructions,
    bannerUrl: data.bannerUrl ? validateHttpsUrl(data.bannerUrl, 'O banner') : null,
    sourceUrl: validateHttpsUrl(data.sourceUrl, 'A fonte oficial'),
  };
}

function formatQuestType(type) {
  return type === 'play' ? 'Play Quest' : 'Video Quest';
}

function formatDeadline(endsAt) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(endsAt)) + ' UTC';
}

function questEmbed(quest) {
  const embed = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(`🎯 ${quest.name}`)
    .setDescription(`**Conteúdo promovido:** ${quest.promoted_content}`)
    .addFields(
      { name: 'Tipo', value: formatQuestType(quest.quest_type), inline: true },
      { name: 'Recompensa oficial', value: quest.reward, inline: true },
      { name: 'Encerramento', value: formatDeadline(quest.ends_at), inline: true },
      { name: 'Requisitos', value: quest.requirements },
      { name: 'Plataformas', value: quest.platforms, inline: true },
      {
        name: 'Última verificação',
        value: `<t:${Math.floor(Date.parse(quest.last_verified_at) / 1000)}:F>`,
        inline: true,
      },
      { name: 'Fonte oficial', value: `[Abrir fonte](${quest.source_url})`, inline: true },
    ));

  if (quest.banner_url) {
    embed.setImage(quest.banner_url);
  }

  return embed;
}

function questActionRow(quest) {
  const button = quest.official_url
    ? new ButtonBuilder()
      .setLabel('Ver Quest no Discord')
      .setStyle(ButtonStyle.Link)
      .setURL(quest.official_url)
    : new ButtonBuilder()
      .setCustomId(`missions:view:${quest.id}`)
      .setLabel('Ver Quest no Discord')
      .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder().addComponents(button);
}

function getQuest(db, guildId, questId) {
  return db.prepare('SELECT * FROM missions WHERE guild_id = ? AND id = ?')
    .get(guildId, questId);
}

export function createMission(db, guildId, actorId, input) {
  const quest = validateQuest(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO missions (
      id, guild_id, name, promoted_content, quest_type, requirements, reward,
      ends_at, platforms, official_url, instructions, banner_url, source_url,
      last_verified_at, status, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    id,
    guildId,
    quest.name,
    quest.promotedContent,
    quest.questType,
    quest.requirements,
    quest.reward,
    quest.endsAt,
    quest.platforms,
    quest.officialUrl,
    quest.instructions,
    quest.bannerUrl,
    quest.sourceUrl,
    now,
    actorId,
    actorId,
    now,
    now,
  );
  writeAuditLog(db, guildId, actorId, 'mission.created', { missionId: id });
  return getQuest(db, guildId, id);
}

export function updateMission(db, guildId, actorId, questId, updates) {
  const existing = getQuest(db, guildId, questId);
  if (!existing) {
    throw new MissionError('Quest não encontrada neste servidor.');
  }
  if (existing.status !== 'active' || Date.parse(existing.ends_at) <= Date.now()) {
    throw new MissionError('Somente Quests ativas e não expiradas podem ser atualizadas.');
  }

  const candidate = validateQuest({
    name: updates.name ?? existing.name,
    promotedContent: updates.promotedContent ?? existing.promoted_content,
    questType: updates.questType ?? existing.quest_type,
    requirements: updates.requirements ?? existing.requirements,
    reward: updates.reward ?? existing.reward,
    endsAt: updates.endsAt ?? existing.ends_at,
    platforms: updates.platforms ?? existing.platforms,
    officialUrl: updates.officialUrl ?? existing.official_url,
    instructions: updates.instructions ?? existing.instructions,
    bannerUrl: updates.bannerUrl ?? existing.banner_url,
    sourceUrl: updates.sourceUrl ?? existing.source_url,
  });
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE missions SET
      name = ?, promoted_content = ?, quest_type = ?, requirements = ?, reward = ?,
      ends_at = ?, platforms = ?, official_url = ?, instructions = ?, banner_url = ?,
      source_url = ?, last_verified_at = ?, updated_by = ?, updated_at = ?,
      alert_sent_at = NULL
    WHERE guild_id = ? AND id = ? AND status = 'active'
  `).run(
    candidate.name,
    candidate.promotedContent,
    candidate.questType,
    candidate.requirements,
    candidate.reward,
    candidate.endsAt,
    candidate.platforms,
    candidate.officialUrl,
    candidate.instructions,
    candidate.bannerUrl,
    candidate.sourceUrl,
    now,
    actorId,
    now,
    guildId,
    questId,
  );
  writeAuditLog(db, guildId, actorId, 'mission.updated', { missionId: questId });
  return getQuest(db, guildId, questId);
}

export function setMissionStatus(db, guildId, actorId, questId, status) {
  if (!['ended', 'unavailable'].includes(status)) {
    throw new MissionError('Situação inválida para encerramento de Quest.');
  }
  const result = db.prepare(`
    UPDATE missions
    SET status = ?, updated_by = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'active'
  `).run(status, actorId, new Date().toISOString(), guildId, questId);
  if (!result.changes) {
    throw new MissionError('Quest ativa não encontrada neste servidor.');
  }
  writeAuditLog(db, guildId, actorId, 'mission.status_changed', {
    missionId: questId,
    status,
  });
  return getQuest(db, guildId, questId);
}

export function listMissions(db, guildId, { includeInactive = false, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const rows = includeInactive
    ? db.prepare(`
      SELECT * FROM missions WHERE guild_id = ?
      ORDER BY ends_at DESC LIMIT 20
    `).all(guildId)
    : db.prepare(`
      SELECT * FROM missions WHERE guild_id = ? AND status = 'active' AND ends_at > ?
      ORDER BY ends_at ASC LIMIT 20
    `).all(guildId, nowIso);
  return rows;
}

export async function publishMission({
  db,
  guild,
  actorId,
  questId,
  channel,
}) {
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    || !channel.isSendable()) {
    throw new MissionError('Selecione um canal de texto ou anúncios válido.');
  }

  const quest = getQuest(db, guild.id, questId);
  if (!quest || quest.status !== 'active' || Date.parse(quest.ends_at) <= Date.now()) {
    throw new MissionError('Essa Quest não existe, está encerrada ou já expirou; nenhum anúncio foi publicado.');
  }
  if (quest.announcement_status === 'publishing') {
    throw new MissionError('A publicação anterior ainda precisa ser conferida no canal; não vou criar um anúncio duplicado.');
  }

  const claimed = withTransaction(db, () => {
    const result = db.prepare(`
      UPDATE missions SET announcement_status = 'publishing'
      WHERE guild_id = ? AND id = ? AND status = 'active'
        AND ends_at > ? AND announcement_status != 'publishing'
    `).run(guild.id, questId, new Date().toISOString());
    return result.changes > 0;
  });
  if (!claimed) {
    throw new MissionError('A Quest já está sendo publicada ou não está mais disponível.');
  }

  const view = {
    embeds: [questEmbed(quest)],
    components: [questActionRow(quest)],
    allowedMentions: { parse: [] },
  };
  let message;
  try {
    message = null;
    if (quest.announced_message_id && quest.announcement_channel_id === channel.id) {
      message = await channel.messages.fetch(quest.announced_message_id).catch((error) => {
        if (error?.code === 10008) {
          return null;
        }
        throw error;
      });
    }

    if (message) {
      await message.edit(view);
    } else {
      message = await channel.send(view);
    }
  } catch (error) {
    writeAuditLog(db, guild.id, actorId, 'mission.publish_uncertain', {
      missionId: questId,
      channelId: channel.id,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE missions
    SET announcement_channel_id = ?, announced_message_id = ?, announcement_status = 'published',
      updated_by = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'active' AND announcement_status = 'publishing'
  `).run(channel.id, message.id, actorId, now, guild.id, questId);
  writeAuditLog(db, guild.id, actorId, 'mission.announced', {
    missionId: questId,
    channelId: channel.id,
    messageId: message.id,
    updated: Boolean(quest.announced_message_id),
  });
  return { message, updated: Boolean(quest.announced_message_id) };
}

export async function handleMissionViewInteraction(interaction, db) {
  if (!interaction.isButton() || !interaction.customId.startsWith('missions:view:')) {
    return false;
  }

  const questId = interaction.customId.slice('missions:view:'.length);
  const quest = getQuest(db, interaction.guildId, questId);
  if (!quest || quest.status !== 'active' || Date.parse(quest.ends_at) <= Date.now()) {
    await interaction.reply({
      content: 'Esta Quest não está mais disponível.',
      ephemeral: true,
    });
    return true;
  }

  const details = quest.official_url
    ? `Link oficial informado pela equipe: ${quest.official_url}`
    : `Como encontrar: ${quest.instructions}\nAbra o Discord: ${discordAppUrl}`;
  await interaction.reply({
    content: `${details}\n\nFonte verificada em ${formatDeadline(quest.last_verified_at)}.`,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
  return true;
}

export function configureMissionAlerts(db, guildId, actorId, channelId) {
  updateGuildSettings(db, guildId, { missionAlertChannelId: channelId });
  writeAuditLog(db, guildId, actorId, 'mission.alert_channel.updated', { channelId });
}

export async function runMissionMaintenance({ client, db, now = new Date() }) {
  const nowIso = now.toISOString();
  const expirationRows = db.prepare(`
    SELECT id, guild_id FROM missions WHERE status = 'active' AND ends_at <= ?
  `).all(nowIso);
  for (const mission of expirationRows) {
    const updated = db.prepare(`
      UPDATE missions SET status = 'ended', updated_at = ?
      WHERE id = ? AND guild_id = ? AND status = 'active' AND ends_at <= ?
    `).run(nowIso, mission.id, mission.guild_id, nowIso);
    if (updated.changes) {
      writeAuditLog(db, mission.guild_id, client.user.id, 'mission.expired', {
        missionId: mission.id,
      });
    }
  }

  const reminderLimit = new Date(now.getTime() + reminderWindowMs).toISOString();
  const dueMissions = db.prepare(`
    SELECT * FROM missions
    WHERE status = 'active' AND ends_at > ? AND ends_at <= ? AND alert_sent_at IS NULL
    ORDER BY ends_at ASC LIMIT 100
  `).all(nowIso, reminderLimit);

  for (const mission of dueMissions) {
    const { settings } = getGuildSettings(db, mission.guild_id);
    const channelId = settings.missionAlertChannelId || settings.logChannelId;
    if (!channelId) {
      if (!missingAlertChannelWarnings.has(mission.guild_id)) {
        console.warn(`Alerta de encerramento de Quest sem canal configurado para o servidor ${mission.guild_id}.`);
        missingAlertChannelWarnings.add(mission.guild_id);
      }
      continue;
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.isSendable() || channel.guildId !== mission.guild_id) {
      throw new MissionError(`Canal de alertas inválido para o servidor ${mission.guild_id}.`);
    }
    await channel.send({
      embeds: [withBrandSignature(new EmbedBuilder()
        .setColor(BRAND.colors.gray)
        .setTitle('Quest perto do encerramento')
        .setDescription([
          `**${mission.name}** (${formatQuestType(mission.quest_type)})`,
          `Encerra em ${formatDeadline(mission.ends_at)}.`,
          `Recompensa confirmada: ${mission.reward}`,
        ].join('\n'))
        .setURL(mission.official_url || mission.source_url))],
      allowedMentions: { parse: [] },
    });
    db.prepare(`
      UPDATE missions SET alert_sent_at = ?
      WHERE id = ? AND guild_id = ? AND status = 'active' AND alert_sent_at IS NULL
    `).run(nowIso, mission.id, mission.guild_id);
  }
  return { expired: expirationRows.length, reminders: dueMissions.length };
}

export function startMissionMaintenance({ client, db, intervalMs = 15 * 60 * 1000 }) {
  const run = () => runMissionMaintenance({ client, db }).catch((error) => {
    console.error(`Falha na manutenção de VANTA MISSIONS (${error.name || 'UnknownError'}).`);
  });
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

export function isMissionAdmin(interaction, db) {
  return isAdmin(interaction, db);
}
