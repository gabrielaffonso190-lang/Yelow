import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from 'discord.js';
import { getGuildSettings, withTransaction, writeAuditLog } from './db.js';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { getBannerUrl } from '../config/banners.js';
import { emojiComponent } from '../config/emojis.js';
import { getOperationalRoleIds, isGuildStaff } from './permissions.js';

const sessionDurationMs = 15 * 60 * 1000;
const closedChannelRetentionMs = 60 * 1000;
const maximumImageBytes = 8 * 1024 * 1024;
const timers = new Map();
const imageDirectory = resolve('data/private-images');

export class CustomizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CustomizationError';
  }
}

function getAllowedStaffRoles(db, guildId, guild) {
  return getOperationalRoleIds(db, guildId, guild);
}

function permissionOverwrites(guild, userId, botUserId, roleIds) {
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: botUserId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    ...roleIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];
}

function schedule(sessionId, expiresAt, callback) {
  const previous = timers.get(sessionId);
  if (previous) {
    clearTimeout(previous);
  }

  const delay = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    callback().catch((error) => {
      console.error(`Falha ao encerrar sessão de personalização (${error.name || 'UnknownError'}).`);
    });
  }, delay);
  timer.unref?.();
  timers.set(sessionId, timer);
}

async function closeSession({ db, client, session, notify = true }) {
  const channelId = session.channel_id;

  if (session.status !== 'closed') {
    db.prepare(`
      UPDATE customization_sessions SET status = 'closed' WHERE id = ?
    `).run(session.id);
    writeAuditLog(db, session.guild_id, session.user_id, 'customization.closed', {
      sessionId: session.id,
      channelId,
    });
  }

  if (!channelId) {
    return;
  }

  const channel = await client.channels.fetch(channelId).catch((error) => {
    if (error?.code === 10003) {
      return null;
    }

    throw error;
  });

  if (!channel) {
    db.prepare('UPDATE customization_sessions SET channel_id = NULL WHERE id = ?')
      .run(session.id);
    return;
  }

  if (notify) {
    try {
      await channel.send(
        `<@${session.user_id}> O prazo de 15 minutos da personalização terminou. A sessão foi encerrada.`,
      );
    } catch (error) {
      console.error(`Falha ao avisar sobre o encerramento da sessão (${error.name || 'UnknownError'}).`);
    }

    try {
      await channel.permissionOverwrites.edit(session.user_id, {
        ViewChannel: false,
        SendMessages: false,
      });
    } catch (error) {
      console.error(`Falha ao bloquear a sessão encerrada (${error.name || 'UnknownError'}).`);
    }
  }

  schedule(session.id, new Date(Date.now() + closedChannelRetentionMs).toISOString(), async () => {
    try {
      await channel.delete('Sessão temporária de personalização encerrada');
      db.prepare('UPDATE customization_sessions SET channel_id = NULL WHERE id = ?')
        .run(session.id);
    } catch (error) {
      if (error?.code === 10003) {
        db.prepare('UPDATE customization_sessions SET channel_id = NULL WHERE id = ?')
          .run(session.id);
        return;
      }

      throw error;
    }
  });
}

export async function createCustomizationSession({
  db,
  guild,
  user,
  clientUserId,
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionDurationMs).toISOString();
  const reservation = withTransaction(db, () => {
    const active = db.prepare(`
      SELECT id, channel_id, expires_at, status, guild_id, user_id FROM customization_sessions
      WHERE guild_id = ? AND user_id = ? AND status IN ('creating', 'active')
      ORDER BY created_at DESC LIMIT 1
    `).get(guild.id, user.id);

    if (active && new Date(active.expires_at).getTime() > now.getTime()) {
      return { active };
    }

    if (active) {
      db.prepare("UPDATE customization_sessions SET status = 'closed' WHERE id = ?")
        .run(active.id);
      return { expired: active };
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO customization_sessions
        (id, guild_id, user_id, status, expires_at, created_at)
      VALUES (?, ?, ?, 'creating', ?, ?)
    `).run(id, guild.id, user.id, expiresAt, now.toISOString());

    return { sessionId: id };
  });

  if (reservation.expired) {
    await closeSession({ db, client: guild.client, session: reservation.expired });
    throw new CustomizationError('Sua sessão anterior expirou e foi encerrada. Tente novamente.');
  }

  if (reservation.active) {
    if (reservation.active.status === 'creating' || !reservation.active.channel_id) {
      throw new CustomizationError('Sua sessão já está sendo criada. Tente novamente em instantes.');
    }

    const activeChannel = await guild.channels.fetch(reservation.active.channel_id).catch((error) => {
      if (error?.code === 10003) {
        return null;
      }

      throw error;
    });

    if (activeChannel) {
      return activeChannel;
    }

    db.prepare(`
      UPDATE customization_sessions SET status = 'closed', channel_id = NULL WHERE id = ?
    `).run(reservation.active.id);
    throw new CustomizationError('Sua sessão anterior está sendo encerrada. Tente novamente em instantes.');
  }

  const { sessionId } = reservation;
  const { settings } = getGuildSettings(db, guild.id);
  const parentId = settings.customizationCategoryId ?? settings.ticketCategoryId;

  let channel;
  try {
    channel = await guild.channels.create({
      name: `personalizacao-${user.id.slice(-5)}`,
      type: ChannelType.GuildText,
      ...(parentId ? { parent: parentId } : {}),
      permissionOverwrites: permissionOverwrites(
        guild,
        user.id,
        clientUserId,
        getAllowedStaffRoles(db, guild.id, guild),
      ),
      reason: `Personalização solicitada por ${user.id}`,
    });

    db.prepare(`
      UPDATE customization_sessions
      SET channel_id = ?, status = 'active' WHERE id = ?
    `).run(channel.id, sessionId);
    writeAuditLog(db, guild.id, user.id, 'customization.opened', {
      sessionId,
      channelId: channel.id,
    });

    await channel.send({
      content: `<@${user.id}> Esta sessão privada dura 15 minutos. Envie uma imagem como anexo ou descreva o que deseja personalizar.`,
    });
    schedule(sessionId, expiresAt, () => closeSession({
      db,
      client: guild.client,
      session: {
        id: sessionId,
        guild_id: guild.id,
        user_id: user.id,
        channel_id: channel.id,
        status: 'active',
      },
    }));

    return channel;
  } catch (error) {
    let cleanupFailed = false;

    if (channel) {
      try {
        await channel.delete('Falha ao iniciar a sessão de personalização');
      } catch (cleanupError) {
        cleanupFailed = true;
        console.error(`Falha ao limpar canal de personalização (${cleanupError.name}).`);
      }
    }

    db.prepare(`
      UPDATE customization_sessions SET status = 'closed', channel_id = ? WHERE id = ?
    `).run(cleanupFailed ? channel.id : null, sessionId);

    if (cleanupFailed && channel) {
      schedule(sessionId, new Date(Date.now() + closedChannelRetentionMs).toISOString(), async () => {
        await channel.delete('Limpeza de sessão de personalização com falha');
        db.prepare('UPDATE customization_sessions SET channel_id = NULL WHERE id = ?')
          .run(sessionId);
      });
    }

    throw error;
  }
}

export async function recoverCustomizationSessions({ db, client }) {
  const sessions = db.prepare(`
    SELECT * FROM customization_sessions
    WHERE status IN ('creating', 'active', 'closed')
      AND (status IN ('creating', 'closed') OR expires_at <= ? OR status = 'active')
  `).all(new Date().toISOString());

  for (const session of sessions) {
    if (session.status === 'closed') {
      if (!session.channel_id) {
        continue;
      }

      schedule(session.id, new Date(Date.now() + closedChannelRetentionMs).toISOString(), async () => {
        try {
          const channel = await client.channels.fetch(session.channel_id);
          await channel.delete('Limpeza de sessão de personalização encerrada');
          db.prepare('UPDATE customization_sessions SET channel_id = NULL WHERE id = ?')
            .run(session.id);
        } catch (error) {
          if (error?.code === 10003) {
            db.prepare('UPDATE customization_sessions SET channel_id = NULL WHERE id = ?')
              .run(session.id);
            return;
          }

          throw error;
        }
      });
      continue;
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await closeSession({ db, client, session });
      continue;
    }

    const channel = session.channel_id
      ? await client.channels.fetch(session.channel_id).catch((error) => {
        if (error?.code === 10003) {
          return null;
        }

        throw error;
      })
      : null;

    if (!channel) {
      db.prepare(`
        UPDATE customization_sessions SET status = 'closed', channel_id = NULL WHERE id = ?
      `).run(session.id);
      writeAuditLog(db, session.guild_id, session.user_id, 'customization.recovered_missing_channel', {
        sessionId: session.id,
      });
      continue;
    }

    schedule(session.id, session.expires_at, () => closeSession({ db, client, session }));
  }
}

function detectImageType(buffer) {
  if (buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', extension: '.png' };
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: '.jpg' };
  }

  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', extension: '.webp' };
  }

  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) {
    return { mime: 'image/gif', extension: '.gif' };
  }

  return null;
}

async function fetchImage(attachment) {
  let url;

  try {
    url = new URL(attachment.url);
  } catch {
    throw new CustomizationError('O anexo possui um endereço inválido.');
  }

  if (url.protocol !== 'https:'
    || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
    || url.username
    || url.password) {
    throw new CustomizationError('Somente anexos hospedados pelo Discord são aceitos.');
  }

  if (attachment.size > maximumImageBytes) {
    throw new CustomizationError('A imagem deve ter no máximo 8 MB.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
    });

    if (!response.ok || !response.body) {
      throw new CustomizationError('Não foi possível baixar o anexo do Discord.');
    }

    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > maximumImageBytes) {
        await reader.cancel();
        throw new CustomizationError('A imagem excede o limite de 8 MB.');
      }

      chunks.push(Buffer.from(value));
    }

    const buffer = Buffer.concat(chunks);
    const type = detectImageType(buffer);

    if (!type || (attachment.contentType && !attachment.contentType.startsWith(type.mime))) {
      throw new CustomizationError('O conteúdo do anexo não corresponde a uma imagem permitida.');
    }

    const suppliedExtension = extname(attachment.name || '').toLowerCase();
    const validExtensions = new Set([type.extension, type.extension === '.jpg' ? '.jpeg' : type.extension]);

    if (suppliedExtension && !validExtensions.has(suppliedExtension)) {
      throw new CustomizationError('A extensão do arquivo não corresponde ao formato da imagem.');
    }

    return { buffer, ...type };
  } finally {
    clearTimeout(timeout);
  }
}

export async function storeMessageImages({ db, message, session }) {
  const imageAttachments = [...message.attachments.values()].filter((attachment) => (
    attachment.contentType?.startsWith('image/')
    || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || '')
  ));

  if (imageAttachments.length === 0) {
    return [];
  }

  await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
  const stored = [];

  for (const attachment of imageAttachments.slice(0, 4)) {
    const image = await fetchImage(attachment);
    const id = randomUUID();
    const filePath = resolve(imageDirectory, `${id}${image.extension}`);

    try {
      await writeFile(filePath, image.buffer, { flag: 'wx', mode: 0o600 });
      db.prepare(`
        INSERT INTO image_assets
          (id, guild_id, user_id, session_id, file_path, mime_type, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        session.guild_id,
        message.author.id,
        session.id,
        filePath,
        image.mime,
        image.buffer.length,
        new Date().toISOString(),
      );
      stored.push({ id, mimeType: image.mime, sizeBytes: image.buffer.length });
    } catch (error) {
      await unlink(filePath).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') {
          console.error(`Falha ao limpar arquivo temporário de imagem (${cleanupError.name}).`);
        }
      });
      throw error;
    }
  }

  return stored;
}

export function getSessionForMessage(db, guildId, channelId) {
  return db.prepare(`
    SELECT * FROM customization_sessions
    WHERE guild_id = ? AND channel_id = ? AND status = 'active'
  `).get(guildId, channelId);
}

export function hasSessionAccess(db, session, member, guild = { id: session.guild_id }) {
  return member.id === session.user_id
    || isGuildStaff({ guild, member, userId: member.id }, db);
}

export function appendUploadedImageToPanel({ db, guildId, assetId, view, kind }) {
  const asset = db.prepare(`
    SELECT file_path, mime_type FROM image_assets WHERE guild_id = ? AND id = ?
  `).get(guildId, assetId);

  if (!asset) {
    throw new CustomizationError('A imagem selecionada não existe neste servidor.');
  }

  const path = resolve(asset.file_path);
  if (!path.startsWith(`${imageDirectory}/`)) {
    throw new CustomizationError('O caminho da imagem armazenada é inválido.');
  }

  const buffer = readFileSync(path);
  const image = detectImageType(buffer);

  if (!image || image.mime !== asset.mime_type) {
    throw new CustomizationError('O arquivo de imagem armazenado está inválido.');
  }

  const name = `${kind}-panel${image.extension}`;
  const file = new AttachmentBuilder(buffer, { name });
  const embed = view.embeds?.[0];

  if (!embed) {
    throw new CustomizationError('O painel não tem um embed para exibir a imagem.');
  }

  embed.setImage(`attachment://${name}`);
  return { ...view, files: [...(view.files || []), file] };
}

export function buildSupportPanel(db, guildId) {
  const { settings } = getGuildSettings(db, guildId);
  const embed = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle('Atendimento')
    .setDescription(settings.ticketWelcome || 'Clique no botão para solicitar atendimento.')
    .setFooter({ text: 'Atendimento privado com a equipe' }));

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('support:create')
        .setLabel('Abrir atendimento')
        .setStyle(ButtonStyle.Primary),
    )],
  };
}

export const CONTRIBUTION_OPTIONS = Object.freeze([
  { value: 'money', label: 'Dinheiro', emoji: 'money' },
  { value: 'card', label: 'Cartão', emoji: 'creditCard' },
  { value: 'dreams', label: 'Sonhos', emoji: 'currency' },
  { value: 'gift', label: 'Presente', emoji: 'gift' },
  { value: 'partnership', label: 'Parceria', emoji: 'partnership' },
]);

export function buildContributorPanel(db, guildId) {
  const { settings } = getGuildSettings(db, guildId);
  const config = settings.contributorPanel ?? {};
  const select = new StringSelectMenuBuilder()
    .setCustomId('contributor:category')
    .setPlaceholder('Selecione uma opção')
    .addOptions(CONTRIBUTION_OPTIONS.map((option) => ({
      label: option.label,
      value: option.value,
      ...(emojiComponent(option.emoji) ? { emoji: emojiComponent(option.emoji) } : {}),
    })));
  const embed = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(config.title || 'CONTRIBUIDOR & PARCERIAS')
    .setDescription(config.description || 'Escolha uma opção para falar com a equipe VANTA.')
    .setImage(getBannerUrl(db, guildId, 'contributor')));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
    allowedMentions: { parse: [] },
  };
}

export async function createContributionTicket({ db, guild, user, botUserId, category }) {
  const option = CONTRIBUTION_OPTIONS.find((entry) => entry.value === category);
  if (!option) throw new CustomizationError('Opção de contribuição inválida.');
  const existing = db.prepare(`
    SELECT * FROM contribution_requests
    WHERE guild_id = ? AND user_id = ? AND category = ?
      AND status IN ('creating', 'open', 'in_service')
    LIMIT 1
  `).get(guild.id, user.id, category);
  if (existing?.status === 'creating') {
    throw new CustomizationError('Sua solicitação está sendo criada. Tente novamente em instantes.');
  }
  if (existing?.channel_id) {
    const channel = await guild.channels.fetch(existing.channel_id).catch((error) => {
      if (error?.code === 10003) return null;
      throw error;
    });
    if (channel) return { channel, requestId: existing.id, duplicate: true };
    db.prepare(`
      UPDATE contribution_requests SET status = 'closed', closed_at = ?, result = ?
      WHERE id = ? AND status IN ('open', 'in_service')
    `).run(new Date().toISOString(), 'Canal não encontrado ao recuperar solicitação.', existing.id);
  }

  const id = randomUUID();
  const openedAt = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO contribution_requests
        (id, guild_id, user_id, category, status, opened_at)
      VALUES (?, ?, ?, ?, 'creating', ?)
    `).run(id, guild.id, user.id, category, openedAt);
    writeAuditLog(db, guild.id, user.id, 'contribution.opening', {
      requestId: id,
      category,
      openedAt,
    });
  });

  const { settings } = getGuildSettings(db, guild.id);
  const panel = settings.contributorPanel ?? {};
  const staffRoleIds = getAllowedStaffRoles(db, guild.id, guild);
  let channel;
  try {
    channel = await guild.channels.create({
      name: `contrib-${category}-${id.slice(0, 6)}`,
      type: ChannelType.GuildText,
      ...(settings.ticketCategoryId ? { parent: settings.ticketCategoryId } : {}),
      permissionOverwrites: permissionOverwrites(guild, user.id, botUserId, staffRoleIds),
      reason: `Solicitação ${option.label} por ${user.id}`,
    });
    db.prepare(`
      UPDATE contribution_requests SET channel_id = ?, status = 'open' WHERE id = ?
    `).run(channel.id, id);
    writeAuditLog(db, guild.id, user.id, 'contribution.opened', {
      requestId: id,
      category,
      channelId: channel.id,
      openedAt,
    });
    const embed = withBrandSignature(new EmbedBuilder()
      .setColor(BRAND.colors.white)
      .setTitle(`Solicitação · ${option.label}`)
      .setDescription([
        `Usuário: <@${user.id}>`,
        `Categoria: **${option.label}**`,
        `Solicitação: \`${id}\``,
        `Aberta em: <t:${Math.floor(Date.parse(openedAt) / 1000)}:F>`,
        'Status: aberta',
      ].join('\n'))
      .setImage(getBannerUrl(db, guild.id, 'cart')));
    await channel.send({
      content: [
        `<@${user.id}> ${panel.welcomeMessage || 'Sua solicitação foi criada. A equipe VANTA responderá por este canal.'}`,
        staffRoleIds.map((roleId) => `<@&${roleId}>`).join(' '),
      ].filter(Boolean).join('\n'),
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`contribution:claim:${id}`)
          .setLabel('Assumir atendimento')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`contribution:transfer:${id}`)
          .setLabel('Transferir')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`contribution:close:${id}`)
          .setLabel('Encerrar solicitação')
          .setStyle(ButtonStyle.Danger),
      )],
      allowedMentions: { users: [user.id], roles: staffRoleIds },
    });
    return { channel, requestId: id, duplicate: false };
  } catch (error) {
    if (channel) await channel.delete('Falha ao criar solicitação de contribuição').catch(() => {});
    db.prepare(`
      UPDATE contribution_requests SET status = 'closed', channel_id = NULL,
        closed_at = ?, result = ? WHERE id = ?
    `).run(new Date().toISOString(), 'Falha ao abrir canal.', id);
    writeAuditLog(db, guild.id, user.id, 'contribution.creation_failed', {
      requestId: id,
      category,
      error: String(error?.code || error?.name || 'UNKNOWN').slice(0, 80),
    });
    throw error;
  }
}

export async function createSupportTicket({ db, guild, user, botUserId }) {
  const existing = db.prepare(`
    SELECT * FROM support_tickets
    WHERE guild_id = ? AND user_id = ? AND status IN ('creating', 'open')
    ORDER BY opened_at DESC LIMIT 1
  `).get(guild.id, user.id);

  if (existing?.status === 'creating') {
    throw new CustomizationError('Seu atendimento está sendo criado. Tente novamente em instantes.');
  }

  if (existing?.channel_id) {
    const channel = await guild.channels.fetch(existing.channel_id).catch((error) => {
      if (error?.code === 10003) {
        return null;
      }

      throw error;
    });

    if (channel) {
      return { channel, duplicate: true };
    }

    db.prepare(`
      UPDATE support_tickets SET status = 'closed', closed_at = ?
      WHERE id = ? AND status = 'open'
    `).run(new Date().toISOString(), existing.id);
  }

  const { settings } = getGuildSettings(db, guild.id);
  const id = randomUUID();
  const now = new Date().toISOString();
  const staffRoleIds = getAllowedStaffRoles(db, guild.id, guild);
  db.prepare(`
    INSERT INTO support_tickets (id, guild_id, user_id, status, opened_at)
    VALUES (?, ?, ?, 'creating', ?)
  `).run(id, guild.id, user.id, now);

  let channel;
  try {
    channel = await guild.channels.create({
      name: `atendimento-${user.id.slice(-5)}`,
      type: ChannelType.GuildText,
      ...(settings.ticketCategoryId ? { parent: settings.ticketCategoryId } : {}),
      permissionOverwrites: permissionOverwrites(guild, user.id, botUserId, staffRoleIds),
      reason: `Atendimento solicitado por ${user.id}`,
    });
    db.prepare(`
      UPDATE support_tickets SET channel_id = ?, status = 'open' WHERE id = ?
    `).run(channel.id, id);
    writeAuditLog(db, guild.id, user.id, 'support_ticket.opened', { ticketId: id, channelId: channel.id });
    await channel.send({
      content: `<@${user.id}> Conte à equipe como podemos ajudar.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`support:close:${id}`)
          .setLabel('Encerrar atendimento')
          .setStyle(ButtonStyle.Secondary),
      )],
    });
    return { channel, duplicate: false };
  } catch (error) {
    if (channel) {
      try {
        await channel.delete('Falha ao criar ticket de atendimento');
      } catch (cleanupError) {
        console.error(`Falha ao limpar canal de atendimento (${cleanupError.name}).`);
      }
    }

    db.prepare(`
      UPDATE support_tickets SET status = 'closed', channel_id = NULL, closed_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), id);
    writeAuditLog(db, guild.id, user.id, 'support_ticket.creation_failed', { ticketId: id });
    throw error;
  }
}

export function closeSupportTicket(db, ticketId, actorId) {
  const ticket = db.prepare(
    "SELECT * FROM support_tickets WHERE id = ? AND status = 'open'",
  ).get(ticketId);

  if (!ticket) {
    throw new CustomizationError('Ticket de atendimento não encontrado ou já fechado.');
  }

  db.prepare(`
    UPDATE support_tickets SET status = 'closed', closed_at = ? WHERE id = ?
  `).run(new Date().toISOString(), ticketId);
  writeAuditLog(db, ticket.guild_id, actorId, 'support_ticket.closed', { ticketId });
  return ticket;
}
