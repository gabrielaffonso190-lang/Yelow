import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  getGuildSettings,
  updateGuildSettings,
  withTransaction,
  writeAuditLog,
} from './db.js';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { getBannerUrl, OFFICIAL_BANNERS } from '../config/banners.js';
import { isAdmin, isStaff } from './permissions.js';
import {
  DEFAULT_NVIDIA_MODEL,
  getAvailableNvidiaModels,
} from './nvidia.js';
import { emojiComponent } from '../config/emojis.js';
import {
  getEffectiveMissionDiscoveryInterval,
  getMissionDiscoveryStatus,
} from './missionDiscovery.js';

export const DEFAULT_MATRIX_CHANNEL_ID = '1560463567025606677';

const sectionLabels = {
  overview: 'Visão geral',
  orders: 'Compras',
  carts: 'Carrinhos',
  tickets: 'Tickets',
  products: 'Produtos',
  coupons: 'Cupons',
  ads: 'Anúncios',
  analytics: 'Analytics',
  health: 'Saúde do sistema',
  feedback: 'Feedback',
  settings: 'Configurações',
  customization: 'Personalização',
  logs: 'Logs',
  missions: 'Missões',
  banners: 'Gerenciamento de Banners',
};

const administratorSections = new Set([
  'products',
  'coupons',
  'ads',
  'settings',
  'customization',
  'logs',
  'missions',
  'banners',
]);

function row(component) {
  return new ActionRowBuilder().addComponents(component);
}

function metric(db, query, ...parameters) {
  return db.prepare(query).get(...parameters).count;
}

function metrics(db, guildId) {
  return {
    orders: metric(db, 'SELECT COUNT(*) AS count FROM orders WHERE guild_id = ?', guildId),
    pendingOrders: metric(
      db,
      "SELECT COUNT(*) AS count FROM orders WHERE guild_id = ? AND status = 'pending'",
      guildId,
    ),
    inServiceOrders: metric(
      db,
      "SELECT COUNT(*) AS count FROM orders WHERE guild_id = ? AND status = 'in_service'",
      guildId,
    ),
    cancelledOrders: metric(
      db,
      "SELECT COUNT(*) AS count FROM orders WHERE guild_id = ? AND status = 'cancelled'",
      guildId,
    ),
    carts: metric(db, 'SELECT COUNT(*) AS count FROM carts WHERE guild_id = ?', guildId),
    openTickets: metric(
      db,
      "SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'open'",
      guildId,
    ) + metric(
      db,
      "SELECT COUNT(*) AS count FROM support_tickets WHERE guild_id = ? AND status = 'open'",
      guildId,
    ),
    closedTickets: metric(
      db,
      "SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'closed'",
      guildId,
    ) + metric(
      db,
      "SELECT COUNT(*) AS count FROM support_tickets WHERE guild_id = ? AND status = 'closed'",
      guildId,
    ),
    availableProducts: metric(
      db,
      'SELECT COUNT(*) AS count FROM products WHERE guild_id = ? AND active = 1 AND (stock IS NULL OR stock > 0)',
      guildId,
    ),
    soldOutProducts: metric(
      db,
      'SELECT COUNT(*) AS count FROM products WHERE guild_id = ? AND active = 1 AND stock = 0',
      guildId,
    ),
    activeCoupons: metric(
      db,
      `SELECT COUNT(*) AS count FROM coupons
       WHERE guild_id = ? AND active = 1
         AND (valid_from IS NULL OR valid_from <= datetime('now'))
         AND (valid_until IS NULL OR valid_until >= datetime('now'))`,
      guildId,
    ),
  };
}

function buildMetricsEmbed(db, guildId, section) {
  const totals = metrics(db, guildId);
  const embed = new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(`${BRAND.name} · MATRIX · ${sectionLabels[section]}`)
    .setFooter({ text: `Servidor ${guildId} · ${BRAND.signature}` });

  if (section === 'overview' || section === 'analytics') {
    embed.setDescription([
      `Pedidos: **${totals.orders}** · pendentes: **${totals.pendingOrders}**`,
      `Em atendimento: **${totals.inServiceOrders}** · cancelados: **${totals.cancelledOrders}**`,
      `Tickets abertos: **${totals.openTickets}** · encerrados: **${totals.closedTickets}**`,
      `Carrinhos: **${totals.carts}**`,
      `Produtos disponíveis: **${totals.availableProducts}** · esgotados: **${totals.soldOutProducts}**`,
      `Cupons ativos: **${totals.activeCoupons}**`,
      'Pedidos concluídos: não rastreados pelo schema atual.',
    ].join('\n'));
    return embed;
  }

  if (section === 'orders') {
    embed.setDescription([
      `Total: **${totals.orders}**`,
      `Pendentes: **${totals.pendingOrders}**`,
      `Em atendimento: **${totals.inServiceOrders}**`,
      `Cancelados: **${totals.cancelledOrders}**`,
      'Não há estado de pagamento ou conclusão no schema atual.',
    ].join('\n'));
    return embed;
  }

  if (section === 'carts') {
    embed.setDescription(`Carrinhos persistidos: **${totals.carts}**.`);
    return embed;
  }

  if (section === 'tickets') {
    embed.setDescription([
      `Abertos: **${totals.openTickets}**`,
      `Encerrados: **${totals.closedTickets}**`,
    ].join('\n'));
    return embed;
  }

  if (section === 'products') {
    embed.setDescription([
      `Disponíveis: **${totals.availableProducts}**`,
      `Esgotados: **${totals.soldOutProducts}**`,
      'Use `/config center` para administrar o catálogo.',
    ].join('\n'));
    return embed;
  }

  if (section === 'coupons') {
    embed.setDescription(`Cupons ativos: **${totals.activeCoupons}**. Use \`/config center\` para gerenciá-los.`);
    return embed;
  }

  if (section === 'ads') {
    const { settings } = getGuildSettings(db, guildId);
    const templates = Object.keys(settings.announcementTemplates ?? {});
    embed.setDescription([
      'Use `/anuncio preparar` para criar uma prévia e publicar após confirmação.',
      `Modelos salvos: ${templates.length ? templates.join(', ') : 'nenhum'}.`,
    ].join('\n'));
    return embed;
  }

  if (section === 'feedback') {
    const feedback = db.prepare(`
      SELECT order_id, user_id, rating, comment, submitted_at FROM order_feedback
      WHERE guild_id = ? ORDER BY submitted_at DESC LIMIT 10
    `).all(guildId);
    const requests = metric(
      db,
      'SELECT COUNT(*) AS count FROM order_feedback_requests WHERE guild_id = ?',
      guildId,
    );
    const average = db.prepare(`
      SELECT AVG(rating) AS average FROM order_feedback WHERE guild_id = ?
    `).get(guildId).average;
    embed.setDescription([
      `Solicitações iniciadas: **${requests}**`,
      `Avaliações recebidas: **${feedback.length ? metric(db, 'SELECT COUNT(*) AS count FROM order_feedback WHERE guild_id = ?', guildId) : 0}** · média: **${average ? average.toFixed(2) : '—'} / 5**`,
      ...(feedback.length ? feedback.map((entry) => (
        `• ${entry.rating}/5 · pedido \`${entry.order_id}\` · <@${entry.user_id}> · ${entry.comment || 'sem comentário'} · <t:${Math.floor(Date.parse(entry.submitted_at) / 1000)}:R>`
      )) : ['Nenhuma avaliação recebida.']),
    ].join('\n').slice(0, 4000));
    return embed;
  }

  if (section === 'banners') {
    const overrides = getGuildSettings(db, guildId).settings.bannerUrls ?? {};
    const lines = Object.entries(OFFICIAL_BANNERS).map(([key, banner]) => (
      `• \`${key}\` · ${banner.label} · ${overrides[key] ? 'personalizado' : 'padrão oficial'}`
    ));
    embed.setDescription(lines.join('\n'));
    return embed;
  }

  if (section === 'settings') {
    embed.setDescription('Abra `/config center` para as configurações atualmente disponíveis.');
    return embed;
  }

  if (section === 'customization') {
    const active = metric(
      db,
      "SELECT COUNT(*) AS count FROM customization_sessions WHERE guild_id = ? AND status = 'active'",
      guildId,
    );
    embed.setDescription(`Sessões de personalização ativas: **${active}**. Prazo configurado: 15 minutos.`);
    return embed;
  }

  if (section === 'logs') {
    const recent = db.prepare(`
      SELECT actor_id, action, created_at FROM audit_logs
      WHERE guild_id = ? ORDER BY id DESC LIMIT 10
    `).all(guildId);
    embed.setDescription(recent.length
      ? recent.map((entry) => (
        `• ${entry.created_at} · ${entry.action} · <@${entry.actor_id}>`
      )).join('\n').slice(0, 4000)
      : 'Nenhuma ação administrativa registrada.');
    return embed;
  }

  if (section === 'missions') {
    const { settings } = getGuildSettings(db, guildId);
    const { sources, candidateCount } = getMissionDiscoveryStatus(db);
    const active = metric(
      db,
      `SELECT COUNT(*) AS count FROM missions
       WHERE guild_id = ? AND status = 'active' AND ends_at > ?`,
      guildId,
      new Date().toISOString(),
    );
    const expiring = metric(
      db,
      `SELECT COUNT(*) AS count FROM missions
       WHERE guild_id = ? AND status = 'active'
         AND ends_at > ? AND ends_at <= ?`,
      guildId,
      new Date().toISOString(),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    const published = metric(
      db,
      `SELECT COUNT(*) AS count FROM missions
       WHERE guild_id = ? AND announcement_status = 'published'`,
      guildId,
    );
    const publicationFailures = metric(
      db,
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE guild_id = ? AND action = 'mission.auto_publish_failed'`,
      guildId,
    );
    const failures = sources.reduce((total, source) => total + source.failure_count, 0);
    const blog = sources.find((source) => source.source_key === 'discord_blog');
    embed.setDescription([
      `Quests ativas e válidas: **${active}**`,
      `Encerram em até 24 horas: **${expiring}**`,
      `Quests publicadas neste servidor: **${published}**`,
      `Falhas de publicação automática: **${publicationFailures}**`,
      `Candidatas aguardando revisão: **${candidateCount}** · falhas de consulta registradas: **${failures}**`,
      `Automação: **${settings.missionAutomationEnabled ? 'ativada' : 'desativada'}** · canal: ${settings.missionAnnouncementChannelId ? `<#${settings.missionAnnouncementChannelId}>` : 'não configurado'}`,
      `Aprovação da equipe: **${settings.missionRequireApproval === false ? 'não exigida' : 'exigida'}** · intervalo: **${settings.missionDiscoveryIntervalMinutes ?? 60} min** neste servidor; **${getEffectiveMissionDiscoveryInterval(db)} min** efetivos no feed`,
      `Última consulta automática: ${blog?.last_checked_at ? `<t:${Math.floor(Date.parse(blog.last_checked_at) / 1000)}:R>` : 'nunca'} · próxima: ${blog?.next_check_at ? `<t:${Math.floor(Date.parse(blog.next_check_at) / 1000)}:R>` : 'não agendada'}`,
      ...(blog?.last_error ? [`Última falha do feed: ${blog.last_error.slice(0, 200)}`] : []),
      'Discord Blog RSS: descoberta automática de artigos, não prova de Quest. Discord Discover → Quests e Discord Newsroom: revisão manual.',
      'Gerenciar: `/config center` · `/missoes fontes` · `/missoes cadastrar`.',
    ].join('\n'));
    return embed;
  }

  throw new Error('Seção MATRIX inválida.');
}

export function buildMatrixPanel() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('matrix:section')
    .setPlaceholder('Abrir uma seção administrativa')
    .addOptions(Object.entries(sectionLabels).map(([value, label]) => ({
      label,
      value,
      ...(emojiComponent(value) ? { emoji: emojiComponent(value) } : {}),
    })));

  return {
    embeds: [withBrandSignature(new EmbedBuilder()
      .setColor(BRAND.colors.white)
      .setTitle(`${BRAND.name} · MATRIX`)
      .setDescription([
        BRAND.slogan,
        'Painel administrativo persistente. Selecione uma seção para consultar dados registrados.',
        'Recursos indisponíveis são indicados sem inventar dados.',
      ].join('\n')))],
    components: [row(select)],
    allowedMentions: { parse: [] },
  };
}

function buildBannerManagementView(db, guildId, key = 'discord_accounts') {
  const banner = OFFICIAL_BANNERS[key];
  const { settings } = getGuildSettings(db, guildId);
  const customized = Boolean(settings.bannerUrls?.[key]);
  const select = new StringSelectMenuBuilder()
    .setCustomId('matrix:banner-select')
    .setPlaceholder('Selecionar banner')
    .addOptions(Object.entries(OFFICIAL_BANNERS).map(([value, entry]) => ({
      label: entry.label,
      value,
      default: value === key,
    })));
  const preview = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(`Banner · ${banner.label}`)
    .setDescription(`Identificador: \`${key}\`\nOrigem: ${customized ? 'URL personalizada' : 'URL oficial VANTA'}`)
    .setImage(getBannerUrl(db, guildId, key)));
  return {
    embeds: [preview],
    components: [
      row(select),
      row(
        new ButtonBuilder()
          .setCustomId(`matrix:banner-preview:${key}`)
          .setLabel('Visualizar')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`matrix:banner-change:${key}`)
          .setLabel('Substituir URL')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`matrix:banner-restore:${key}`)
          .setLabel('Restaurar padrão')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!customized),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function recordUnauthorizedMatrixAction(interaction, db) {
  if (interaction.inGuild()) {
    writeAuditLog(db, interaction.guildId, interaction.user.id, 'matrix.unauthorized_action', {
      customId: interaction.customId,
    });
  }
}

async function handleBannerComponent(interaction, db) {
  if (!interaction.inGuild() || !isAdmin(interaction, db)) {
    recordUnauthorizedMatrixAction(interaction, db);
    await interaction.reply({ content: 'Esta ação exige permissão administrativa.', ephemeral: true });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'matrix:banner-select') {
    const key = interaction.values[0];
    if (!Object.hasOwn(OFFICIAL_BANNERS, key)) {
      await interaction.reply({ content: 'Banner inválido.', ephemeral: true });
      return true;
    }
    await interaction.update(buildBannerManagementView(db, interaction.guildId, key));
    return true;
  }

  if (!interaction.isButton()) return false;
  const [, action, keyOrDraftId] = interaction.customId.split(':');

  if (action === 'banner-preview' || action === 'banner-restore' || action === 'banner-change') {
    const key = keyOrDraftId;
    if (!Object.hasOwn(OFFICIAL_BANNERS, key)) {
      await interaction.reply({ content: 'Banner inválido.', ephemeral: true });
      return true;
    }
    if (action === 'banner-preview') {
      await interaction.reply({
        embeds: buildBannerManagementView(db, interaction.guildId, key).embeds,
        ephemeral: true,
      });
      return true;
    }
    if (action === 'banner-change') {
      const input = new TextInputBuilder()
        .setCustomId('url')
        .setLabel('URL HTTPS da imagem')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(500)
        .setRequired(true);
      const modal = new ModalBuilder()
        .setCustomId(`matrix:banner-url:${key}`)
        .setTitle(`Alterar · ${OFFICIAL_BANNERS[key].label}`)
        .addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    const { settings } = getGuildSettings(db, interaction.guildId);
    const bannerUrls = { ...(settings.bannerUrls ?? {}) };
    const previousUrl = bannerUrls[key] ?? OFFICIAL_BANNERS[key].url;
    delete bannerUrls[key];
    withTransaction(db, () => {
      updateGuildSettings(db, interaction.guildId, { bannerUrls });
      writeAuditLog(db, interaction.guildId, interaction.user.id, 'banner.restored', {
        key,
        previousUrl,
        restoredUrl: OFFICIAL_BANNERS[key].url,
      });
    });
    await interaction.update(buildBannerManagementView(db, interaction.guildId, key));
    return true;
  }

  if (action === 'banner-save' || action === 'banner-cancel') {
    const draft = db.prepare('SELECT * FROM action_drafts WHERE id = ?')
      .get(keyOrDraftId);
    if (!draft || draft.guild_id !== interaction.guildId
      || draft.user_id !== interaction.user.id || draft.status !== 'pending') {
      await interaction.reply({ content: 'Esta prévia expirou ou não pertence a você.', ephemeral: true });
      return true;
    }
    if (action === 'banner-cancel') {
      db.prepare("UPDATE action_drafts SET status = 'rejected' WHERE id = ?").run(draft.id);
      await interaction.update({ content: 'Alteração cancelada.', embeds: [], components: [] });
      return true;
    }
    if (Date.parse(draft.expires_at) <= Date.now()) {
      db.prepare("UPDATE action_drafts SET status = 'expired' WHERE id = ?").run(draft.id);
      await interaction.reply({ content: 'Esta prévia expirou. Gere outra para salvar.', ephemeral: true });
      return true;
    }
    const key = draft.target.slice('banner:'.length);
    if (!Object.hasOwn(OFFICIAL_BANNERS, key)) {
      await interaction.reply({ content: 'Banner inválido.', ephemeral: true });
      return true;
    }
    const { settings } = getGuildSettings(db, interaction.guildId);
    const bannerUrls = { ...(settings.bannerUrls ?? {}), [key]: draft.value };
    withTransaction(db, () => {
      updateGuildSettings(db, interaction.guildId, { bannerUrls });
      db.prepare("UPDATE action_drafts SET status = 'applied' WHERE id = ?").run(draft.id);
      writeAuditLog(db, interaction.guildId, interaction.user.id, 'banner.updated', {
        key,
        previousUrl: settings.bannerUrls?.[key] ?? OFFICIAL_BANNERS[key].url,
        url: draft.value,
      });
    });
    await interaction.update({
      content: `Banner **${OFFICIAL_BANNERS[key].label}** salvo.`,
      embeds: [],
      components: [],
    });
    return true;
  }
  return false;
}

export async function handleMatrixModal(interaction, { db }) {
  if (!interaction.customId.startsWith('matrix:banner-url:')) return false;
  if (!interaction.inGuild() || !isAdmin(interaction, db)) {
    recordUnauthorizedMatrixAction(interaction, db);
    await interaction.reply({ content: 'Esta ação exige permissão administrativa.', ephemeral: true });
    return true;
  }
  const key = interaction.customId.slice('matrix:banner-url:'.length);
  const rawUrl = interaction.fields.getTextInputValue('url').trim();
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    await interaction.reply({ content: 'Informe uma URL válida.', ephemeral: true });
    return true;
  }
  if (!Object.hasOwn(OFFICIAL_BANNERS, key) || url.protocol !== 'https:'
    || url.username || url.password) {
    await interaction.reply({ content: 'A imagem deve usar uma URL HTTPS válida.', ephemeral: true });
    return true;
  }

  const id = randomUUID();
  const now = new Date();
  db.prepare(`
    INSERT INTO action_drafts
      (id, guild_id, user_id, channel_id, target, value, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    interaction.guildId,
    interaction.user.id,
    interaction.channelId,
    `banner:${key}`,
    url.href,
    new Date(now.getTime() + 15 * 60_000).toISOString(),
    now.toISOString(),
  );
  writeAuditLog(db, interaction.guildId, interaction.user.id, 'banner.previewed', { key, url: url.href });
  const preview = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(`Prévia · ${OFFICIAL_BANNERS[key].label}`)
    .setDescription(`Identificador: \`${key}\`\nConfirme para salvar a URL.`)
    .setImage(url.href));
  await interaction.reply({
    embeds: [preview],
    components: [row(
      new ButtonBuilder().setCustomId(`matrix:banner-save:${id}`).setLabel('Salvar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`matrix:banner-cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
  return true;
}

function getMatrixChannelId(env = process.env) {
  const channelId = env.MATRIX_CHANNEL_ID?.trim() || DEFAULT_MATRIX_CHANNEL_ID;
  if (!/^\d{17,20}$/.test(channelId)) {
    throw new Error('Invalid Discord ID in environment variable: MATRIX_CHANNEL_ID');
  }
  return channelId;
}

function isUnknownMessageError(error) {
  return error?.code === 10008;
}

export async function recoverMatrixPanel({ client, db, env = process.env }) {
  const channelId = getMatrixChannelId(env);
  const channel = await client.channels.fetch(channelId);

  if (!channel?.isTextBased() || !channel.isSendable() || !channel.guild) {
    throw new Error('MATRIX_CHANNEL_ID must identify a sendable guild text channel.');
  }

  const { settings } = getGuildSettings(db, channel.guild.id);
  const panelMessageId = settings.matrixPanelMessageId;
  const panelChannelId = settings.matrixPanelChannelId;

  if (panelMessageId && panelChannelId === channel.id) {
    try {
      const message = await channel.messages.fetch(panelMessageId);
      await message.edit(buildMatrixPanel());
      return message;
    } catch (error) {
      if (!isUnknownMessageError(error)) {
        throw error;
      }
    }
  } else if (panelMessageId && panelChannelId) {
    const oldChannel = await client.channels.fetch(panelChannelId).catch((error) => {
      if (error?.code === 10003) {
        return null;
      }
      throw error;
    });

    if (oldChannel?.isTextBased() && oldChannel.messages) {
      const oldMessage = await oldChannel.messages.fetch(panelMessageId).catch((error) => {
        if (isUnknownMessageError(error)) {
          return null;
        }
        throw error;
      });
      if (oldMessage) {
        await oldMessage.edit({
          content: 'Este painel MATRIX foi movido para outro canal.',
          embeds: [],
          components: [],
        });
      }
    }
  }

  const message = await channel.send(buildMatrixPanel());
  updateGuildSettings(db, channel.guild.id, {
    matrixPanelChannelId: channel.id,
    matrixPanelMessageId: message.id,
  });
  writeAuditLog(db, channel.guild.id, client.user.id, 'matrix.panel.created', {
    channelId: channel.id,
    messageId: message.id,
  });
  return message;
}

export async function buildHealthEmbed({
  client,
  db,
  env = process.env,
  guildId = client.guilds.cache.first()?.id ?? '',
}) {
  const startedAt = performance.now();
  const cpuBefore = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cpuAfter = process.cpuUsage(cpuBefore);
  const elapsedMs = performance.now() - startedAt;
  const cpuCount = Math.max(1, os.cpus().length);
  const cpuPercent = Math.min(
    100,
    ((cpuAfter.user + cpuAfter.system) / (elapsedMs * 1000 * cpuCount)) * 100,
  );
  const ping = client.ws.ping;
  let databaseStatus = { label: 'Indisponível', detail: 'Consulta SQLite falhou.' };
  let settings = {};

  try {
    db.prepare('SELECT 1 AS ok').get();
    databaseStatus = { label: 'Operacional', detail: 'SQLite respondeu à consulta de verificação.' };
    settings = getGuildSettings(db, guildId).settings;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    databaseStatus = { label: 'Indisponível', detail: `Falha de consulta (${errorName}).` };
  }

  let aiStatus;
  const huehueConfigured = Boolean(env.HUEHUE_API_KEY?.trim());
  if (settings.ai?.enabled === false) {
    aiStatus = { label: 'Não configurado', detail: 'IA desativada neste servidor.' };
  } else if (!env.NVIDIA_API_KEY?.trim()) {
    aiStatus = huehueConfigured
      ? {
        label: 'Degradado',
        detail: 'NVIDIA_API_KEY ausente; HUEHUE_API_KEY configurada, conectividade não verificada.',
      }
      : { label: 'Não configurado', detail: 'Configure NVIDIA_API_KEY ou HUEHUE_API_KEY.' };
  } else {
    try {
      const availableModels = await getAvailableNvidiaModels({
        apiKey: env.NVIDIA_API_KEY,
      });
      const selectedModel = availableModels.includes(DEFAULT_NVIDIA_MODEL)
        ? DEFAULT_NVIDIA_MODEL
        : null;
      aiStatus = selectedModel
        ? {
          label: 'Degradado',
          detail: `Modelo ${selectedModel} listado; geração não verificada.${huehueConfigured ? ' Fallback Huehue configurado, conectividade não verificada.' : ''}`,
        }
        : huehueConfigured
          ? {
            label: 'Degradado',
            detail: `O modelo ${DEFAULT_NVIDIA_MODEL} não está listado; fallback Huehue configurado, conectividade não verificada.`,
          }
          : {
            label: 'Indisponível',
            detail: `O modelo ${DEFAULT_NVIDIA_MODEL} não está listado para esta conta NVIDIA.`,
          };
    } catch (error) {
      aiStatus = huehueConfigured
        ? {
          label: 'Degradado',
          detail: `Falha ao consultar NVIDIA; fallback Huehue configurado, conectividade não verificada (${error instanceof Error ? error.name : 'UnknownError'}).`,
        }
        : {
          label: 'Degradado',
          detail: error instanceof Error ? error.message : 'Não foi possível consultar os modelos NVIDIA.',
        };
    }
  }
  const discordStatus = !client.isReady()
    ? { label: 'Indisponível', detail: 'Cliente Discord não está pronto.' }
    : ping < 0 || ping > 500
      ? { label: 'Degradado', detail: `Gateway conectado; latência ${ping < 0 ? 'indisponível' : `${ping} ms`}.` }
      : { label: 'Operacional', detail: `Latência ${ping} ms.` };
  const database = databaseStatus;
  const zpayConfigured = Boolean(env.ZPAY_CLIENT_ID?.trim() && env.ZPAY_CLIENT_SECRET?.trim());
  const voxpayConfigured = Boolean(env.VOXPAY_API_KEY?.trim());
  const preferredProvider = env.PAYMENT_PROVIDER?.trim().toLowerCase() || 'zpay';
  const zpay = {
    label: zpayConfigured ? 'Configurado' : 'Não configurado',
    detail: zpayConfigured
      ? `Credenciais definidas; conectividade não verificada.${preferredProvider === 'zpay' ? ' Provedor principal.' : ''}`
      : 'Configure ZPAY_CLIENT_ID e ZPAY_CLIENT_SECRET.',
  };
  const voxpay = {
    label: voxpayConfigured ? 'Configurado' : 'Não configurado',
    detail: voxpayConfigured
      ? `Credencial definida; conectividade não verificada.${preferredProvider === 'voxpay' ? ' Provedor principal.' : ''}`
      : 'Configure VOXPAY_API_KEY para habilitar o fallback.',
  };
  const tasks = {
    label: 'Operacional',
    detail: 'A recuperação de sessões de personalização está habilitada.',
  };
  const uptimeSeconds = Math.floor((client.uptime ?? 0) / 1000);
  const uptime = [
    Math.floor(uptimeSeconds / 86400),
    Math.floor((uptimeSeconds % 86400) / 3600),
    Math.floor((uptimeSeconds % 3600) / 60),
  ].map((value) => String(value).padStart(2, '0')).join(':');

  return withBrandSignature(new EmbedBuilder()
    .setColor(database.label === 'Indisponível' || discordStatus.label === 'Indisponível'
      ? BRAND.colors.white
      : BRAND.colors.gray)
    .setTitle(`Diagnóstico ${BRAND.name}`)
    .addFields(
      { name: 'Discord', value: `${discordStatus.label} — ${discordStatus.detail}` },
      { name: 'Banco de dados', value: `${database.label} — ${database.detail}` },
      { name: 'IA', value: `${aiStatus.label} — ${aiStatus.detail}` },
      { name: 'Z.PAY', value: `${zpay.label} — ${zpay.detail}` },
      { name: 'VoxPay', value: `${voxpay.label} — ${voxpay.detail}` },
      { name: 'Tarefas automáticas', value: `${tasks.label} — ${tasks.detail}` },
      { name: 'Uptime', value: uptime, inline: true },
      { name: 'Memória RSS', value: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`, inline: true },
      { name: 'CPU do processo', value: `${cpuPercent.toFixed(1)}%`, inline: true },
    )
    .setTimestamp());
}

export async function handleMatrixInteraction(interaction, { db }) {
  if (interaction.customId.startsWith('matrix:banner')) {
    return handleBannerComponent(interaction, db);
  }
  if (!interaction.isStringSelectMenu() || interaction.customId !== 'matrix:section') {
    return false;
  }

  if (!interaction.inGuild() || !isStaff(interaction, db)) {
    await interaction.reply({
      content: 'Você não tem permissão para consultar o MATRIX.',
      ephemeral: true,
    });
    return true;
  }

  const section = interaction.values[0];
  if (!Object.hasOwn(sectionLabels, section)) {
    await interaction.reply({ content: 'Seção MATRIX inválida.', ephemeral: true });
    return true;
  }

  if (administratorSections.has(section) && !isAdmin(interaction, db)) {
    await interaction.reply({
      content: 'Esta seção exige uma permissão administrativa.',
      ephemeral: true,
    });
    return true;
  }

  if (section === 'health') {
    await interaction.deferReply({ ephemeral: true });
    const embed = await buildHealthEmbed({
      client: interaction.client,
      db,
      guildId: interaction.guildId,
    });
    await interaction.editReply({ embeds: [embed] });
    return true;
  }

  if (section === 'banners') {
    await interaction.reply({
      ...buildBannerManagementView(db, interaction.guildId),
      ephemeral: true,
    });
    return true;
  }

  await interaction.reply({
    embeds: [buildMetricsEmbed(db, interaction.guildId, section)],
    ephemeral: true,
  });
  return true;
}
