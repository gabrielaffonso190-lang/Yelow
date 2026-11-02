import os from 'node:os';
import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { getGuildSettings, updateGuildSettings, writeAuditLog } from './db.js';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { isAdmin, isStaff } from './permissions.js';

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
};

const administratorSections = new Set([
  'products',
  'coupons',
  'ads',
  'settings',
  'customization',
  'logs',
  'missions',
]);

function row(component) {
  return new ActionRowBuilder().addComponents(component);
}

function metric(db, query, guildId) {
  return db.prepare(query).get(guildId).count;
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
    embed.setDescription('O banco atual não possui um módulo de feedback.');
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
    embed.setDescription('O sistema de missões não está implementado.');
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

  const aiStatus = settings.ai?.enabled === false
    ? { label: 'Não configurado', detail: 'IA desativada neste servidor.' }
    : env.NVIDIA_API_KEY?.trim()
      ? { label: 'Degradado', detail: 'Credencial definida; disponibilidade do provedor não verificada.' }
      : { label: 'Não configurado', detail: 'NVIDIA_API_KEY ausente.' };
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

  await interaction.reply({
    embeds: [buildMetricsEmbed(db, interaction.guildId, section)],
    ephemeral: true,
  });
  return true;
}
