import { createHash, randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import sharp from 'sharp';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { emojiText } from '../config/emojis.js';
import {
  getGuildSettings,
  updateGuildSettings,
  withTransaction,
  writeAuditLog,
} from './db.js';
import { isAdmin } from './permissions.js';
import { validateMissionImage } from './missionImages.js';

const maximumFieldLength = 1000;
const reminderWindowMs = 24 * 60 * 60 * 1000;
const missingAlertChannelWarnings = new Set();
const discordAppUrl = 'https://discord.com/app';
const maximumImageBytes = 8 * 1024 * 1024;
const allowedMentionLimit = 10;

function isUniqueConstraint(error) {
  return error?.errcode === 2067;
}

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
  const bannerUrl = data.bannerUrl ? validateHttpsUrl(data.bannerUrl, 'O banner') : null;
  const imageSourceUrl = data.imageSourceUrl
    ? validateHttpsUrl(data.imageSourceUrl, 'A fonte da imagem')
    : null;

  if (!officialUrl && !instructions) {
    throw new MissionError('Informe o link oficial ou instruções para encontrar a Quest no Discord.');
  }
  if (imageSourceUrl && !bannerUrl) {
    throw new MissionError('Informe um banner junto com a fonte da imagem.');
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
    bannerUrl,
    imageSourceUrl,
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

function questEmbed(quest, imageAttachmentName = null) {
  const embed = new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(`${emojiText('missions') || '🎯'} ${quest.name}`)
    .setDescription(`**Conteúdo promovido:** ${quest.promoted_content}`)
    .addFields(
      { name: 'Tipo', value: formatQuestType(quest.quest_type), inline: true },
      { name: 'Recompensa oficial', value: quest.reward, inline: true },
      { name: 'Encerramento', value: formatDeadline(quest.ends_at), inline: true },
      { name: 'Requisitos', value: quest.requirements },
      { name: 'Plataformas', value: quest.platforms, inline: true },
      ...(quest.image_source
        ? [{
          name: 'Imagem',
          value: `${quest.image_source}${quest.image_source_url ? `\n[Origem](${quest.image_source_url})` : ''}`,
          inline: true,
        }]
        : []),
      {
        name: 'Última verificação',
        value: `<t:${Math.floor(Date.parse(quest.last_verified_at) / 1000)}:F>`,
        inline: true,
      },
      {
        name: `Fonte oficial · ${quest.source_name || 'verificada'}`.slice(0, 256),
        value: [
          `[Abrir fonte](${quest.source_url})`,
          quest.source_published_at
            ? `Publicado: <t:${Math.floor(Date.parse(quest.source_published_at) / 1000)}:d>`
            : '',
        ].filter(Boolean).join('\n'),
        inline: true,
      },
    )
    .setFooter({ text: `${BRAND.name} — ${BRAND.slogan}` });

  if (quest.banner_url) {
    embed.setImage(quest.banner_url);
  } else if (imageAttachmentName) {
    embed.setImage(`attachment://${imageAttachmentName}`);
  }

  return embed;
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[character]);
}

export async function renderVantaQuestImage(quest) {
  const title = escapeXml(quest.name.slice(0, 100));
  const promotedContent = escapeXml(quest.promoted_content.slice(0, 100));
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <linearGradient id="background" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#090909"/>
          <stop offset="1" stop-color="#303030"/>
        </linearGradient>
        <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M48 0H0V48" fill="none" stroke="#ffffff" stroke-opacity=".06"/>
        </pattern>
      </defs>
      <rect width="1200" height="630" fill="url(#background)"/>
      <rect width="1200" height="630" fill="url(#grid)"/>
      <rect x="72" y="76" width="8" height="478" fill="#ffffff"/>
      <text x="112" y="150" fill="#a0a0a0" font-family="Arial,sans-serif" font-size="26" letter-spacing="8">VANTA MISSIONS</text>
      <text x="112" y="270" fill="#ffffff" font-family="Arial,sans-serif" font-size="58" font-weight="700">${title}</text>
      <text x="112" y="350" fill="#c4c4c4" font-family="Arial,sans-serif" font-size="34">${promotedContent}</text>
      <text x="112" y="510" fill="#a0a0a0" font-family="Arial,sans-serif" font-size="24">QUEST OFICIAL · INFORMAÇÕES VERIFICADAS</text>
      <text x="112" y="570" fill="#ffffff" font-family="Arial,sans-serif" font-size="20">Technology without limits.</text>
    </svg>
  `);
  return sharp(svg, { limitInputPixels: 1200 * 630 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function sourceMetadata(db, sourceUrl, bannerUrl, imageSourceUrl, name, promotedContent, missionId) {
  const source = new URL(sourceUrl);
  const sourceName = source.hostname === 'discord.com' && source.pathname.startsWith('/blog/')
    ? 'Discord Blog'
    : source.hostname === 'discord.com' && source.pathname.startsWith('/newsroom/')
      ? 'Discord Newsroom'
      : 'Fonte oficial informada pela equipe';
  const discovered = db.prepare(`
    SELECT published_at FROM mission_discovery_entries
    WHERE source_key = 'discord_blog' AND url = ?
  `).get(sourceUrl);
  const fingerprint = createHash('sha256')
    .update(`${sourceUrl.replace(/[?#].*$/, '').toLowerCase()}|${name.toLowerCase()}|${promotedContent.toLowerCase()}`)
    .digest('hex');
  return {
    sourceName,
    sourcePublishedAt: discovered?.published_at ?? null,
    imageSource: bannerUrl
      ? imageSourceUrl ? 'Fonte oficial da imagem informada' : 'Imagem fornecida pela equipe'
      : 'Arte gerada pela VANTA',
    imageSourceUrl: imageSourceUrl ?? null,
    imageIdentifier: bannerUrl
      ? createHash('sha256').update(bannerUrl).digest('hex')
      : `vanta:${missionId}`,
    fingerprint,
  };
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
  const metadata = sourceMetadata(
    db,
    quest.sourceUrl,
    quest.bannerUrl,
    quest.imageSourceUrl,
    quest.name,
    quest.promotedContent,
    id,
  );
  const now = new Date().toISOString();
  try {
    db.prepare(`
    INSERT INTO missions (
      id, guild_id, name, promoted_content, quest_type, requirements, reward,
      ends_at, platforms, official_url, instructions, banner_url, source_url,
      last_verified_at, status, created_by, updated_by, created_at, updated_at,
      source_name, source_published_at, image_source, image_identifier,
      campaign_fingerprint, image_source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    metadata.sourceName,
    metadata.sourcePublishedAt,
    metadata.imageSource,
    metadata.imageIdentifier,
    metadata.fingerprint,
    metadata.imageSourceUrl,
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new MissionError('Esta Quest já foi cadastrada neste servidor com a mesma fonte.');
    }
    throw error;
  }
  db.prepare(`
    UPDATE mission_discovery_entries SET status = 'imported'
    WHERE source_key = 'discord_blog' AND url = ? AND status = 'review'
  `).run(quest.sourceUrl);
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
    imageSourceUrl: updates.imageSourceUrl
      ?? (updates.bannerUrl && updates.bannerUrl !== existing.banner_url
        ? null
        : existing.image_source_url),
    sourceUrl: updates.sourceUrl ?? existing.source_url,
  });
  const metadata = sourceMetadata(
    db,
    candidate.sourceUrl,
    candidate.bannerUrl,
    candidate.imageSourceUrl,
    candidate.name,
    candidate.promotedContent,
    existing.id,
  );
  const now = new Date(Math.max(Date.now(), Date.parse(existing.updated_at) + 1)).toISOString();
  try {
    db.prepare(`
    UPDATE missions SET
      name = ?, promoted_content = ?, quest_type = ?, requirements = ?, reward = ?,
      ends_at = ?, platforms = ?, official_url = ?, instructions = ?, banner_url = ?,
      source_url = ?, last_verified_at = ?, updated_by = ?, updated_at = ?,
      alert_sent_at = NULL, source_name = ?, source_published_at = ?,
      image_source = ?, image_source_url = ?, image_identifier = ?, campaign_fingerprint = ?
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
    metadata.sourceName,
    metadata.sourcePublishedAt,
    metadata.imageSource,
    metadata.imageSourceUrl,
    metadata.imageIdentifier,
    metadata.fingerprint,
    guildId,
    questId,
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new MissionError('Outra Quest deste servidor já usa essa fonte e identificação.');
    }
    throw error;
  }
  db.prepare(`
    UPDATE mission_discovery_entries SET status = 'imported'
    WHERE source_key = 'discord_blog' AND url = ? AND status = 'review'
  `).run(candidate.sourceUrl);
  writeAuditLog(db, guildId, actorId, 'mission.updated', {
    missionId: questId,
    previous: {
      name: existing.name,
      promotedContent: existing.promoted_content,
      questType: existing.quest_type,
      requirements: existing.requirements,
      reward: existing.reward,
      endsAt: existing.ends_at,
      platforms: existing.platforms,
      sourceUrl: existing.source_url,
      bannerUrl: existing.banner_url,
    },
    next: {
      name: candidate.name,
      promotedContent: candidate.promotedContent,
      questType: candidate.questType,
      requirements: candidate.requirements,
      reward: candidate.reward,
      endsAt: candidate.endsAt,
      platforms: candidate.platforms,
      sourceUrl: candidate.sourceUrl,
      bannerUrl: candidate.bannerUrl,
    },
  });
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

export async function syncMissionAnnouncementStatus({ client, quest }) {
  if (!quest.announcement_channel_id || !quest.announced_message_id) {
    return false;
  }
  const channel = await client.channels.fetch(quest.announcement_channel_id).catch((error) => {
    if (error?.code === 10003) {
      return null;
    }
    throw error;
  });
  if (!channel?.messages) {
    return false;
  }
  const message = await channel.messages.fetch(quest.announced_message_id).catch((error) => {
    if (error?.code === 10008) {
      return null;
    }
    throw error;
  });
  if (!message) {
    return false;
  }

  const statusLabel = quest.status === 'ended' ? 'ENCERRADA' : 'INDISPONÍVEL';
  const embeds = message.embeds[0]
    ? [EmbedBuilder.from(message.embeds[0])
      .setTitle(`🎯 ${quest.name} · ${statusLabel}`.slice(0, 256))
      .setColor(BRAND.colors.gray)]
    : [];
  await message.edit({
    embeds,
    components: [],
    allowedMentions: { parse: [] },
  });
  return true;
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
  allowedRoleIds,
  validateImage = validateMissionImage,
  renderImage = renderVantaQuestImage,
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
  const configuredRoles = allowedRoleIds
    ?? getGuildSettings(db, guild.id).settings.missionAllowedRoleIds
    ?? [];
  const mentionRoles = Array.isArray(configuredRoles)
    ? configuredRoles.filter((id) => /^\d{17,20}$/.test(id)).slice(0, allowedMentionLimit)
    : [];

  let attachmentName;
  let imageFile;
  if (quest.banner_url) {
    try {
      await validateImage(quest.banner_url);
    } catch (error) {
      throw new MissionError(error instanceof Error
        ? error.message
        : 'A imagem da Quest não pôde ser validada.');
    }
  } else {
    attachmentName = `vanta-quest-${quest.id}.png`;
    const imageBuffer = await renderImage(quest);
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.byteLength > maximumImageBytes) {
      throw new MissionError('A arte VANTA gerada excedeu o tamanho máximo permitido.');
    }
    imageFile = new AttachmentBuilder(imageBuffer, { name: attachmentName });
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
    embeds: [questEmbed(quest, attachmentName)],
    components: [questActionRow(quest)],
    ...(imageFile ? { files: [imageFile] } : {}),
    ...(mentionRoles.length
      ? { content: mentionRoles.map((id) => `<@&${id}>`).join(' ') }
      : {}),
    allowedMentions: {
      parse: [],
      roles: mentionRoles,
    },
  };
  let message;
  try {
    message = null;
    if (quest.announced_message_id) {
      if (quest.announcement_channel_id === channel.id) {
        message = await channel.messages.fetch(quest.announced_message_id).catch((error) => {
          if (error?.code === 10008) {
            return null;
          }
          throw error;
        });
      } else {
        const previousChannel = await guild.channels.fetch(quest.announcement_channel_id).catch((error) => {
          if (error?.code === 10003) {
            return null;
          }
          throw error;
        });
        const previousMessage = previousChannel?.messages
          ? await previousChannel.messages.fetch(quest.announced_message_id).catch((error) => {
            if (error?.code === 10008) {
              return null;
            }
            throw error;
          })
          : null;
        if (previousMessage) {
          await previousMessage.edit({
            content: 'Este anúncio foi movido para o canal configurado para VANTA MISSIONS.',
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
          });
        }
      }
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
      announcement_updated_at = ?, updated_by = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'active' AND announcement_status = 'publishing'
  `).run(channel.id, message.id, now, actorId, now, guild.id, questId);
  writeAuditLog(db, guild.id, actorId, 'mission.announced', {
    missionId: questId,
    channelId: channel.id,
    messageId: message.id,
    updated: Boolean(quest.announced_message_id),
  });
  return { message, updated: Boolean(quest.announced_message_id) };
}

export async function buildMissionAnnouncementPreview() {
  const imageName = 'vanta-mission-preview.png';
  const image = await renderVantaQuestImage({
    name: 'Nome da Quest',
    promoted_content: 'Jogo ou conteúdo',
  });
  const embed = new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle('Prévia · Nome oficial da Quest')
    .setDescription('**Conteúdo promovido:** Nome do jogo ou conteúdo')
    .addFields(
      { name: 'Tipo', value: 'Play Quest ou Video Quest', inline: true },
      { name: 'Recompensa oficial', value: 'Somente recompensa confirmada', inline: true },
      { name: 'Encerramento', value: 'Data e horário verificados', inline: true },
      { name: 'Requisitos', value: 'Requisitos oficiais completos' },
      { name: 'Plataformas', value: 'Plataformas confirmadas', inline: true },
      { name: 'Última verificação', value: 'Data da verificação', inline: true },
      { name: 'Fonte oficial', value: 'Link registrado pela equipe', inline: true },
    )
    .setImage(`attachment://${imageName}`)
    .setFooter({ text: `${BRAND.name} — ${BRAND.slogan} · PRÉVIA, sem Quest real` });

  return {
    embeds: [embed],
    files: [new AttachmentBuilder(image, { name: imageName })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('missions:preview')
        .setLabel('Ver Quest no Discord')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
    )],
    allowedMentions: { parse: [] },
  };
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
      const expiredMission = getQuest(db, mission.guild_id, mission.id);
      try {
        await syncMissionAnnouncementStatus({ client, quest: expiredMission });
      } catch (error) {
        console.error(`Falha ao atualizar anúncio da Quest encerrada (${error.name || 'UnknownError'}).`);
      }
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
        .setTitle(`${emojiText('bell') || '🔔'} Quest perto do encerramento`)
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
