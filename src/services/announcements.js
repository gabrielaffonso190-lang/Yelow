import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { getGuildSettings, updateGuildSettings, withTransaction, writeAuditLog } from './db.js';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { isAdmin } from './permissions.js';

const draftLifetimeMs = 15 * 60 * 1000;
const maximumImageBytes = 8 * 1024 * 1024;
const imageHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export class AnnouncementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnnouncementError';
  }
}

function getOptionalString(interaction, name) {
  return interaction.options.getString(name)?.trim() || null;
}

function validateImage(attachment) {
  if (!attachment) {
    return null;
  }

  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new AnnouncementError('A imagem anexada possui um endereço inválido.');
  }

  if (url.protocol !== 'https:'
    || !imageHosts.has(url.hostname)
    || url.username
    || url.password
    || !attachment.contentType?.startsWith('image/')
    || attachment.size > maximumImageBytes) {
    throw new AnnouncementError('Anexe uma imagem do Discord com no máximo 8 MB.');
  }

  return {
    url: url.toString(),
    name: attachment.name.slice(0, 100),
  };
}

function validateLink(label, rawUrl) {
  if (!label && !rawUrl) {
    return null;
  }

  if (!label || !rawUrl || label.length > 80) {
    throw new AnnouncementError('Preencha o rótulo e o link do botão.');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AnnouncementError('O link do botão é inválido.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.toString().length > 512) {
    throw new AnnouncementError('O botão deve usar um link HTTPS válido.');
  }

  return { label, url: url.toString() };
}

function buildAnnouncementEmbed(data) {
  const embed = withBrandSignature(new EmbedBuilder()
    .setColor(Number.parseInt(data.color.slice(1), 16))
    .setTitle(data.title)
    .setDescription(data.description)
    .setTimestamp());

  if (data.footer) {
    embed.setFooter({ text: `${data.footer} · ${BRAND.signature}` });
  }
  if (data.image?.url) {
    embed.setImage(data.image.url);
  }

  return embed;
}

function saveTemplate(db, guildId, name, data) {
  if (!name) {
    return;
  }

  if (!/^[A-Za-z0-9_-]{1,30}$/.test(name)) {
    throw new AnnouncementError('O nome do modelo deve ter de 1 a 30 caracteres: letras, números, _ ou -.');
  }

  const { settings } = getGuildSettings(db, guildId);
  const templates = { ...(settings.announcementTemplates ?? {}) };
  delete templates[name];
  templates[name] = {
    title: data.title,
    description: data.description,
    channelId: data.channelId,
    color: data.color,
    footer: data.footer,
    roleId: data.roleId,
    button: data.button,
  };
  const limitedTemplates = Object.fromEntries(Object.entries(templates).slice(-10));
  updateGuildSettings(db, guildId, { announcementTemplates: limitedTemplates });
}

function resolveDraft(interaction, db) {
  const { settings } = getGuildSettings(db, interaction.guildId);
  const templateName = getOptionalString(interaction, 'modelo');
  const templates = settings.announcementTemplates ?? {};
  const template = templateName ? templates[templateName] : null;

  if (templateName && !template) {
    throw new AnnouncementError('Esse modelo de anúncio não existe neste servidor.');
  }

  const title = getOptionalString(interaction, 'titulo') ?? template?.title;
  const description = getOptionalString(interaction, 'descricao') ?? template?.description;
  const selectedChannel = interaction.options.getChannel('canal');
  const channelId = selectedChannel?.id ?? template?.channelId;
  const rawColor = getOptionalString(interaction, 'cor')
    ?? template?.color
    ?? `#${BRAND.colors.white.toString(16).padStart(6, '0')}`;
  const footer = getOptionalString(interaction, 'rodape') ?? template?.footer ?? '';
  const selectedRole = interaction.options.getRole('mencionar_cargo');
  const roleId = selectedRole?.id ?? template?.roleId ?? null;
  const attachment = validateImage(interaction.options.getAttachment('imagem'));
  const buttonLabel = getOptionalString(interaction, 'botao_texto') ?? template?.button?.label ?? null;
  const buttonUrl = getOptionalString(interaction, 'botao_url') ?? template?.button?.url ?? null;
  const button = validateLink(buttonLabel, buttonUrl);
  const saveTemplateName = getOptionalString(interaction, 'salvar_modelo');

  if (!title || title.length > 256 || !description || description.length > 4000) {
    throw new AnnouncementError('Informe título (até 256 caracteres) e descrição (até 4.000 caracteres).');
  }
  if (!channelId) {
    throw new AnnouncementError('Selecione um canal de destino ou use um modelo com canal configurado.');
  }
  if (!/^#[\da-fA-F]{6}$/.test(rawColor)) {
    throw new AnnouncementError('A cor deve usar o formato hexadecimal #RRGGBB.');
  }
  if (footer.length > 2048) {
    throw new AnnouncementError('O rodapé pode ter até 2.048 caracteres.');
  }
  if (roleId && !interaction.guild.roles.cache.has(roleId)) {
    throw new AnnouncementError('O cargo de menção do modelo não existe mais neste servidor.');
  }
  if (saveTemplateName && !/^[A-Za-z0-9_-]{1,30}$/.test(saveTemplateName)) {
    throw new AnnouncementError('O nome do modelo deve ter de 1 a 30 caracteres: letras, números, _ ou -.');
  }

  return {
    title,
    description,
    channelId,
    color: rawColor.toUpperCase(),
    footer,
    roleId,
    image: attachment,
    button,
    templateName: saveTemplateName,
  };
}

export async function createAnnouncementPreview(interaction, db) {
  if (!interaction.inGuild() || !isAdmin(interaction, db)) {
    await interaction.reply({
      content: 'Somente administradores autorizados podem preparar anúncios.',
      ephemeral: true,
    });
    return true;
  }

  const data = resolveDraft(interaction, db);
  saveTemplate(db, interaction.guildId, data.templateName, data);
  if (data.templateName) {
    writeAuditLog(db, interaction.guildId, interaction.user.id, 'announcement.template.saved', {
      name: data.templateName,
    });
  }
  const draftId = randomUUID();
  const now = new Date();
  db.prepare(`
    INSERT INTO action_drafts
      (id, guild_id, user_id, channel_id, target, value, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, 'announcement', ?, 'pending', ?, ?)
  `).run(
    draftId,
    interaction.guildId,
    interaction.user.id,
    interaction.channelId,
    JSON.stringify(data),
    new Date(now.getTime() + draftLifetimeMs).toISOString(),
    now.toISOString(),
  );
  writeAuditLog(db, interaction.guildId, interaction.user.id, 'announcement.drafted', {
    draftId,
    channelId: data.channelId,
  });

  const components = [];
  if (data.button) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(data.button.label)
        .setStyle(ButtonStyle.Link)
        .setURL(data.button.url),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`announcement:publish:${draftId}`)
      .setLabel('Confirmar publicação')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`announcement:cancel:${draftId}`)
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary),
  ));

  await interaction.reply({
    content: `Pré-visualização para <#${data.channelId}>. A confirmação expira em 15 minutos.`,
    embeds: [buildAnnouncementEmbed(data)],
    components,
    allowedMentions: { parse: [] },
    ephemeral: true,
  });
  return true;
}

function validateStoredDraft(draft) {
  let data;
  try {
    data = JSON.parse(draft.value);
  } catch {
    throw new AnnouncementError('O conteúdo do anúncio salvo está inválido.');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)
    || typeof data.title !== 'string'
    || data.title.length > 256
    || typeof data.description !== 'string'
    || data.description.length > 4000
    || typeof data.channelId !== 'string'
    || !/^#[\da-fA-F]{6}$/.test(data.color)) {
    throw new AnnouncementError('O conteúdo do anúncio salvo está incompleto.');
  }

  if (data.image) {
    if (typeof data.image.url !== 'string' || typeof data.image.name !== 'string') {
      throw new AnnouncementError('A imagem salva no anúncio está inválida.');
    }

    let url;
    try {
      url = new URL(data.image.url);
    } catch {
      throw new AnnouncementError('A imagem salva no anúncio possui um endereço inválido.');
    }
    if (url.protocol !== 'https:' || !imageHosts.has(url.hostname) || url.username || url.password) {
      throw new AnnouncementError('A imagem salva aponta para um endereço inválido.');
    }
  }

  if (data.button) {
    if (typeof data.button.label !== 'string' || typeof data.button.url !== 'string') {
      throw new AnnouncementError('O botão salvo no anúncio está inválido.');
    }
    validateLink(data.button.label, data.button.url);
  }

  return data;
}

export async function handleAnnouncementInteraction(interaction, db) {
  const [, action, draftId] = interaction.customId.split(':');
  if (!['publish', 'cancel'].includes(action) || !draftId) {
    await interaction.reply({ content: 'Ação de anúncio inválida.', ephemeral: true });
    return true;
  }

  if (!isAdmin(interaction, db)) {
    await interaction.reply({
      content: 'Somente administradores autorizados podem publicar ou cancelar anúncios.',
      ephemeral: true,
    });
    return true;
  }

  const draft = db.prepare(`
    SELECT * FROM action_drafts WHERE id = ? AND guild_id = ? AND target = 'announcement'
  `).get(draftId, interaction.guildId);

  if (!draft || draft.channel_id !== interaction.channelId) {
    await interaction.reply({ content: 'Este rascunho não pertence a este servidor ou canal.', ephemeral: true });
    return true;
  }

  if (draft.status !== 'pending') {
    await interaction.reply({ content: 'Este anúncio já foi processado.', ephemeral: true });
    return true;
  }

  if (Date.parse(draft.expires_at) <= Date.now()) {
    db.prepare("UPDATE action_drafts SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(draft.id);
    await interaction.reply({ content: 'A pré-visualização expirou. Prepare outro anúncio.', ephemeral: true });
    return true;
  }

  if (action === 'cancel') {
    db.prepare("UPDATE action_drafts SET status = 'rejected' WHERE id = ? AND status = 'pending'")
      .run(draft.id);
    writeAuditLog(db, interaction.guildId, interaction.user.id, 'announcement.cancelled', { draftId });
    await interaction.update({ content: 'Anúncio cancelado.', embeds: [], components: [] });
    return true;
  }

  let data;
  try {
    data = validateStoredDraft(draft);
  } catch (error) {
    if (!(error instanceof AnnouncementError)) {
      throw error;
    }

    await interaction.reply({ content: error.message, ephemeral: true });
    return true;
  }
  const channel = await interaction.guild.channels.fetch(data.channelId).catch((error) => {
    if (error?.code === 10003) {
      return null;
    }
    throw error;
  });
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    || !channel.isSendable()) {
    await interaction.reply({
      content: 'O canal de destino não existe ou não aceita mensagens.',
      ephemeral: true,
    });
    return true;
  }
  if (data.roleId && !interaction.guild.roles.cache.has(data.roleId)) {
    await interaction.reply({
      content: 'O cargo autorizado para menção não existe mais. Prepare o anúncio novamente.',
      ephemeral: true,
    });
    return true;
  }

  const claimed = withTransaction(db, () => {
    const updated = db.prepare(`
      UPDATE action_drafts SET status = 'applied'
      WHERE id = ? AND guild_id = ? AND status = 'pending'
    `).run(draft.id, interaction.guildId);
    if (!updated.changes) {
      return false;
    }
    db.prepare(`
      INSERT INTO announcement_publications
        (draft_id, guild_id, channel_id, status, created_at)
      VALUES (?, ?, ?, 'publishing', ?)
    `).run(draft.id, interaction.guildId, channel.id, new Date().toISOString());
    writeAuditLog(db, interaction.guildId, interaction.user.id, 'announcement.publishing', {
      draftId,
      channelId: channel.id,
    });
    return true;
  });

  if (!claimed) {
    await interaction.reply({ content: 'Este anúncio já está sendo processado.', ephemeral: true });
    return true;
  }

  await interaction.deferUpdate();
  let message;
  try {
    message = await channel.send({
      content: data.roleId ? `<@&${data.roleId}>` : undefined,
      embeds: [buildAnnouncementEmbed(data)],
      components: data.button
        ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(data.button.label)
            .setStyle(ButtonStyle.Link)
            .setURL(data.button.url),
        )]
        : [],
      allowedMentions: {
        parse: [],
        roles: data.roleId ? [data.roleId] : [],
      },
    });
  } catch (error) {
    db.prepare(`
      UPDATE announcement_publications SET status = 'failed'
      WHERE draft_id = ? AND status = 'publishing'
    `).run(draftId);
    writeAuditLog(db, interaction.guildId, interaction.user.id, 'announcement.publish_failed', {
      draftId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    console.error(`Falha ao publicar anúncio (${error instanceof Error ? error.name : 'UnknownError'}).`);
    await interaction.editReply({
      content: 'Não foi possível confirmar a publicação. Verifique o canal de destino antes de criar outro anúncio, para evitar duplicação.',
      embeds: [],
      components: [],
    });
    return true;
  }

  db.prepare(`
    UPDATE announcement_publications SET status = 'published', message_id = ?
    WHERE draft_id = ? AND status = 'publishing'
  `).run(message.id, draftId);
  writeAuditLog(db, interaction.guildId, interaction.user.id, 'announcement.published', {
    draftId,
    channelId: channel.id,
    messageId: message.id,
  });
  await interaction.editReply({
    content: `Anúncio publicado em <#${channel.id}>.`,
    embeds: [],
    components: [],
  });
  return true;
}
