import { randomUUID } from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { createOrderPayment, PaymentError, refreshOrderPayment } from '../services/payments.js';
import { formatMoney } from '../services/commerce.js';
import { isAdmin, isStaff } from '../services/permissions.js';
import { withTransaction, writeAuditLog } from '../services/db.js';
import { buildPixMessage } from '../services/payments.js';

const durationUnits = Object.freeze({ m: 60_000, h: 3_600_000, d: 86_400_000 });

export function parseLocalPaymentDuration(value) {
  const match = /^(\d{1,4})(m|h|d)$/i.exec(value.trim());
  if (!match) throw new Error('Use um prazo como 30m, 2h ou 1d.');
  const amount = Number(match[1]);
  const milliseconds = amount * durationUnits[match[2].toLowerCase()];
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 60_000 || milliseconds > 7 * 86_400_000) {
    throw new Error('O prazo local deve estar entre 1 minuto e 7 dias.');
  }
  return milliseconds;
}

function staffOnly(interaction, db) {
  return interaction.inGuild() && isStaff(interaction, db);
}

export const generateCommand = {
  data: new SlashCommandBuilder()
    .setName('gerar')
    .setDescription('Gera cobranças administrativas.')
    .addSubcommand((subcommand) => subcommand
      .setName('pix')
      .setDescription('Gera uma cobrança Pix Z.PAY com prazo local.')
      .addNumberOption((option) => option
        .setName('valor')
        .setDescription('Valor da cobrança em reais (R$ 2,00 a R$ 2.000,00).')
        .setMinValue(2)
        .setMaxValue(2000)
        .setRequired(true))
      .addStringOption((option) => option
        .setName('tempo')
        .setDescription('Prazo local, como 30m, 2h ou 1d.')
        .setMaxLength(8)
        .setRequired(true))),

  async execute(interaction, services) {
    const { db } = services;
    if (!staffOnly(interaction, db) || !isAdmin(interaction, db)) {
      await interaction.reply({ content: 'Somente administradores autorizados podem gerar cobranças.', ephemeral: true });
      return;
    }

    const amount = interaction.options.getNumber('valor');
    let durationMs;
    try {
      durationMs = parseLocalPaymentDuration(interaction.options.getString('tempo'));
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }
    const amountCents = Math.round(amount * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents < 200 || amountCents > 200_000) {
      await interaction.reply({ content: 'A cobrança deve estar entre R$ 2,00 e R$ 2.000,00.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const orderId = randomUUID();
    const createdAt = new Date();
    const localExpiresAt = new Date(createdAt.getTime() + durationMs).toISOString();
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO orders
          (id, guild_id, user_id, status, subtotal_cents, discount_cents, total_cents, created_at)
        VALUES (?, ?, ?, 'pending', ?, 0, ?, ?)
      `).run(orderId, interaction.guildId, interaction.user.id, amountCents, amountCents, createdAt.toISOString());
      db.prepare(`
        INSERT INTO manual_payment_requests (order_id, requested_by, local_expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(orderId, interaction.user.id, localExpiresAt, createdAt.toISOString());
      writeAuditLog(db, interaction.guildId, interaction.user.id, 'payment.manual_requested', {
        orderId,
        amountCents,
        localExpiresAt,
      });
    });

    try {
      const payment = await createOrderPayment({
        db,
        orderId,
        payerName: interaction.user.globalName || interaction.user.username,
        providers: services.payments?.providers ?? {},
        providerOrder: services.payments?.providerOrder ?? ['zpay', 'voxpay'],
      });
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      await interaction.editReply({
        ...buildPixMessage(payment, order, db, {
          localExpiresAt,
          includePaymentRefresh: false,
        }),
        content: 'Cobrança administrativa gerada. O prazo exibido é local e não expira a cobrança no provedor.',
      });
    } catch (error) {
      const message = error instanceof PaymentError
        ? error.message
        : 'Não foi possível gerar a cobrança. Consulte o histórico do pedido antes de tentar novamente.';
      await interaction.editReply(`Pedido \`${orderId}\` registrado. ${message}`);
    }
  },
};

function orderDetails(db, order) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_name')
    .all(order.id);
  const payment = db.prepare(`
    SELECT provider, provider_payment_id, status, amount_cents, created_at, paid_at
    FROM payments WHERE order_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(order.id);
  const ticket = db.prepare('SELECT status, channel_id FROM tickets WHERE order_id = ?').get(order.id);
  const productLines = items.length
    ? items.map((item) => `${item.product_name} × ${item.quantity} · ${formatMoney(item.unit_price_cents * item.quantity)}`)
    : ['Cobrança avulsa; sem itens de catálogo.'];
  return [
    `Pedido \`${order.id}\` · cliente <@${order.user_id}>`,
    ...productLines,
    `Quantidade total: ${items.reduce((total, item) => total + item.quantity, 0) || 1}`,
    `Valor: ${formatMoney(order.total_cents)} · status: ${order.status}`,
    `Pagamento: ${payment ? `${payment.provider} · ${payment.status} · ${payment.provider_payment_id || 'sem ID do provedor'}` : 'não iniciado'}`,
    `Entrega: não rastreada automaticamente${ticket?.channel_id ? ` · atendimento <#${ticket.channel_id}> (${ticket.status})` : ''}`,
    `Histórico: criado em ${order.created_at}${payment?.paid_at ? ` · pago em ${payment.paid_at}` : ''}`,
  ].join('\n').slice(0, 1000);
}

export const orderCommand = {
  data: new SlashCommandBuilder()
    .setName('pedido')
    .setDescription('Consulta pedidos por identificador ou membro.')
    .addStringOption((option) => option
      .setName('id')
      .setDescription('ID exato do pedido.')
      .setMaxLength(80))
    .addUserOption((option) => option
      .setName('membro')
      .setDescription('Membro cujos pedidos serão consultados.')),

  async execute(interaction, services) {
    const { db } = services;
    if (!staffOnly(interaction, db)) {
      await interaction.reply({ content: 'Somente a equipe autorizada pode consultar pedidos.', ephemeral: true });
      return;
    }
    const orderId = interaction.options.getString('id');
    const member = interaction.options.getUser('membro');
    if (!orderId && !member) {
      await interaction.reply({ content: 'Informe o ID do pedido ou um membro.', ephemeral: true });
      return;
    }
    const orders = orderId
      ? [db.prepare('SELECT * FROM orders WHERE guild_id = ? AND id = ?').get(interaction.guildId, orderId)].filter(Boolean)
      : db.prepare(`
        SELECT * FROM orders WHERE guild_id = ? AND user_id = ?
        ORDER BY created_at DESC LIMIT 10
      `).all(interaction.guildId, member.id);
    if (!orders.length) {
      await interaction.reply({ content: 'Nenhum pedido correspondente foi encontrado.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    if (orderId && services.payments?.providers && Object.keys(services.payments.providers).length) {
      const payment = db.prepare(`
        SELECT status FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(orderId);
      if (payment?.status === 'pending') {
        await refreshOrderPayment({ db, orderId, providers: services.payments.providers }).catch(() => null);
      }
    }
    const embed = withBrandSignature(new EmbedBuilder()
      .setColor(BRAND.colors.white)
      .setTitle('Consulta de pedidos')
      .setDescription(orders.map((order) => orderDetails(db, order)).join('\n\n').slice(0, 4000)));
    await interaction.editReply({ embeds: [embed] });
  },
};

export const stockCommand = {
  data: new SlashCommandBuilder()
    .setName('estoque')
    .setDescription('Consulta e ajusta o estoque cadastrado.')
    .addSubcommand((subcommand) => subcommand
      .setName('consultar')
      .setDescription('Consulta um produto e seu estoque.')
      .addStringOption((option) => option
        .setName('produto')
        .setDescription('ID ou nome exato do produto.')
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName('ajustar')
      .setDescription('Altera estoque com justificativa e auditoria.')
      .addStringOption((option) => option
        .setName('produto')
        .setDescription('ID ou nome exato do produto.')
        .setRequired(true))
      .addIntegerOption((option) => option
        .setName('quantidade')
        .setDescription('Nova quantidade em estoque.')
        .setMinValue(0)
        .setMaxValue(1000000)
        .setRequired(true))
      .addStringOption((option) => option
        .setName('justificativa')
        .setDescription('Motivo da alteração.')
        .setMaxLength(300)
        .setRequired(true))),

  async execute(interaction, { db }) {
    const action = interaction.options.getSubcommand();
    if (action === 'ajustar' ? !interaction.inGuild() || !isAdmin(interaction, db) : !staffOnly(interaction, db)) {
      await interaction.reply({ content: 'Você não tem permissão para esta ação de estoque.', ephemeral: true });
      return;
    }
    const identifier = interaction.options.getString('produto').trim();
    const product = db.prepare(`
      SELECT id, name, category, stock, active FROM products
      WHERE guild_id = ? AND (id = ? OR name = ?)
      LIMIT 1
    `).get(interaction.guildId, identifier, identifier);
    if (!product) {
      await interaction.reply({ content: 'Produto não encontrado. Informe ID ou nome exato.', ephemeral: true });
      return;
    }

    if (action === 'consultar') {
      const changes = db.prepare(`
        SELECT actor_id, details, created_at FROM audit_logs
        WHERE guild_id = ? AND action = 'inventory.adjusted'
        ORDER BY id DESC LIMIT 20
      `).all(interaction.guildId).filter((entry) => {
        try { return JSON.parse(entry.details).productId === product.id; } catch { return false; }
      }).slice(0, 5);
      const history = changes.length
        ? changes.map((entry) => {
          const detail = JSON.parse(entry.details);
          return `${detail.previousStock ?? 'ilimitado'} → ${detail.stock} por <@${entry.actor_id}> · ${entry.created_at}`;
        }).join('\n')
        : 'Sem alterações registradas.';
      await interaction.reply({
        content: `**${product.name}** · ${product.active ? 'ativo' : 'desativado'} · estoque: ${product.stock === null ? 'ilimitado' : product.stock}\nHistórico recente:\n${history}`,
        ephemeral: true,
      });
      return;
    }

    const stock = interaction.options.getInteger('quantidade');
    const reason = interaction.options.getString('justificativa').trim();
    if (!reason) {
      await interaction.reply({ content: 'A justificativa não pode ficar vazia.', ephemeral: true });
      return;
    }
    withTransaction(db, () => {
      db.prepare('UPDATE products SET stock = ? WHERE guild_id = ? AND id = ?')
        .run(stock, interaction.guildId, product.id);
      writeAuditLog(db, interaction.guildId, interaction.user.id, 'inventory.adjusted', {
        productId: product.id,
        productName: product.name,
        previousStock: product.stock,
        stock,
        reason,
      });
    });
    await interaction.reply({ content: `Estoque de **${product.name}** atualizado para **${stock}**.`, ephemeral: true });
  },
};
