import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  applyCartCoupon,
  calculateSalePrice,
  closeOrderTicket,
  CommerceError,
  createOrderTicket,
  formatMoney,
  getCart,
  getCartTotals,
  setCartItem,
} from '../services/commerce.js';
import {
  closeSupportTicket,
  createSupportTicket,
} from '../services/customization.js';
import { getGuildSettings, writeAuditLog } from '../services/db.js';
import { getOperationalRoleIds, isStaff } from '../services/permissions.js';
import {
  buildCartView,
  buildProductDetailView,
  buildQuantityModal,
  buildShopView,
} from '../services/ui.js';
import {
  handleConfigurationComponent,
  handleConfigurationModal,
} from '../services/configuration.js';
import { handleDraftInteraction } from '../services/ai.js';
import { handleMatrixInteraction } from '../services/matrix.js';
import { handleAnnouncementInteraction } from '../services/announcements.js';
import { handleMissionViewInteraction } from '../services/missions.js';
import {
  buildPixMessage,
  createOrderPayment,
  PaymentError,
  refreshOrderPayment,
} from '../services/payments.js';

function isGuildInteraction(interaction) {
  return interaction.inGuild() && interaction.guildId && interaction.guild;
}

function makeModal(customId, title, inputId, label, options = {}) {
  const input = new TextInputBuilder()
    .setCustomId(inputId)
    .setLabel(label)
    .setStyle(options.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(options.required ?? true)
    .setMaxLength(options.maxLength ?? 100);

  if (options.placeholder) {
    input.setPlaceholder(options.placeholder);
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function isBuyerOrStaff(interaction, db, order) {
  return interaction.user.id === order.user_id || isStaff(interaction, db);
}

function orderSummary(db, guildId, orderId) {
  const order = db.prepare(
    'SELECT * FROM orders WHERE id = ? AND guild_id = ?',
  ).get(orderId, guildId);

  if (!order) {
    return null;
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?')
    .all(orderId);
  const lines = items.map((item) => (
    `• ${item.product_name} × ${item.quantity} — ${formatMoney(item.unit_price_cents * item.quantity)}`
  ));

  return {
    order,
    content: [
      `Pedido \`${order.id}\``,
      `Cliente: <@${order.user_id}>`,
      ...lines,
      `Subtotal: ${formatMoney(order.subtotal_cents)}`,
      `Desconto: ${formatMoney(order.discount_cents)}`,
      `Total: ${formatMoney(order.total_cents)}`,
      `Status: ${order.status}`,
    ].join('\n'),
  };
}

async function notifySupportRequest({
  db,
  guild,
  channel,
  userId,
  productId,
  details,
  notifyFounder = false,
}) {
  const { settings } = getGuildSettings(db, guild.id);
  const roleIds = getOperationalRoleIds(db, guild.id, guild);
  const founderId = notifyFounder ? settings.founderUserId : null;
  const userIds = [...new Set([userId, ...(founderId ? [founderId] : [])])];
  const mentions = [
    roleIds.map((id) => `<@&${id}>`).join(' '),
    ...userIds.map((id) => `<@${id}>`),
  ].filter(Boolean);

  await channel.send({
    content: `${mentions.join(' ')}\n${details}`,
    allowedMentions: { users: userIds, roles: roleIds },
  });
  writeAuditLog(db, guild.id, userId, 'support.product_requested', {
    productId,
    founderNotified: Boolean(founderId),
  });
}

async function handleShopSelect(interaction, db) {
  if (interaction.customId === 'shop:category') {
    const category = interaction.values[0];
    await interaction.reply({
      ...buildShopView(db, interaction.guildId, category),
      ephemeral: true,
    });
    return true;
  }

  if (interaction.customId === 'shop:product') {
    const productId = interaction.values[0];
    const product = db.prepare(`
      SELECT id, name, description, category, price_cents, cost_cents, stock, active, image_asset_id
      FROM products
      WHERE id = ? AND guild_id = ?
    `).get(productId, interaction.guildId);

    if (!product || !product.active || product.stock === 0) {
      await interaction.reply({
        content: 'Este produto está indisponível.',
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({
      ...buildProductDetailView(db, interaction.guildId, product),
      ephemeral: true,
    });
    return true;
  }

  return false;
}

async function handleProductAdd(interaction, db) {
  const productId = interaction.customId.split(':')[2];
  const product = db.prepare(`
    SELECT id, name, description, price_cents, cost_cents, stock, active
    FROM products WHERE guild_id = ? AND id = ?
  `).get(interaction.guildId, productId);

  if (!product || !product.active || product.stock === 0) {
    throw new CommerceError('Este produto está indisponível.');
  }

  if (product.name === 'Robux') {
    await interaction.showModal(makeModal(
      `inquiry:robux:${product.id}`,
      'Solicitar Robux',
      'quantity',
      'Quantidade (100 a 17.000)',
      { maxLength: 5, placeholder: '100' },
    ));
    return true;
  }

  if (product.name.startsWith('GamePass')) {
    await interaction.showModal(makeModal(
      `inquiry:gamepass:${product.id}`,
      'Solicitar GamePass',
      'details',
      'Qual GamePass você deseja?',
      { maxLength: 500, paragraph: true },
    ));
    return true;
  }

  if (product.cost_cents === null) {
    await interaction.deferReply({ ephemeral: true });
    const ticket = await createSupportTicket({
      db,
      guild: interaction.guild,
      user: interaction.user,
      botUserId: interaction.client.user.id,
    });
    await notifySupportRequest({
      db,
      guild: interaction.guild,
      channel: ticket.channel,
      userId: interaction.user.id,
      productId,
      details: `Solicita confirmação de preço/disponibilidade para **${product.name}**.`,
    });
    await interaction.editReply(
      `O preço deste produto precisa ser confirmado pela equipe. Solicitação encaminhada para ${ticket.channel}.`,
    );
    return true;
  }

  if (product.price_cents !== calculateSalePrice(product.cost_cents)) {
    throw new CommerceError('O custo do produto foi alterado. A equipe precisa revisar o preço de venda.');
  }

  await interaction.showModal(buildQuantityModal(product.id));
  return true;
}

async function handleCartSelect(interaction, db) {
  const productId = interaction.values[0];
  const cart = getCart(db, interaction.guildId, interaction.user.id);
  const item = cart.items.find((entry) => entry.product_id === productId);

  if (!item) {
    await interaction.reply({ content: 'Esse produto não está no seu carrinho.', ephemeral: true });
    return true;
  }

  await interaction.showModal(buildQuantityModal(productId, 'cart', item.quantity));
  return true;
}

async function handleShopPage(interaction, db) {
  const [, , encodedCategory, rawPage] = interaction.customId.split(':');
  let category;

  try {
    category = Buffer.from(encodedCategory, 'base64url').toString('utf8');
  } catch {
    throw new CommerceError('A página do catálogo expirou.');
  }

  const page = Number(rawPage);
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new CommerceError('Página do catálogo inválida.');
  }

  await interaction.reply({
    ...buildShopView(db, interaction.guildId, category, page),
    ephemeral: true,
  });
  return true;
}

async function handleOrderButton(interaction, services) {
  const { db } = services;
  const [, action, orderId] = interaction.customId.split(':');
  const result = orderSummary(db, interaction.guildId, orderId);

  if (!result) {
    await interaction.reply({ content: 'Pedido não encontrado.', ephemeral: true });
    return true;
  }

  const ticket = db.prepare(
    'SELECT channel_id FROM tickets WHERE order_id = ?',
  ).get(orderId);
  if (ticket?.channel_id !== interaction.channelId) {
    await interaction.reply({ content: 'Este botão não pertence a este canal de pedido.', ephemeral: true });
    return true;
  }

  if (!isBuyerOrStaff(interaction, db, result.order)) {
    await interaction.reply({ content: 'Você não tem acesso a este pedido.', ephemeral: true });
    return true;
  }

  if (action === 'refresh') {
    await interaction.reply({ content: result.content, ephemeral: true });
    return true;
  }

  if (action === 'payment') {
    if (!services.payments?.providers) {
      await interaction.reply({ content: 'Consulta de pagamento indisponível.', ephemeral: true });
      return true;
    }
    const payment = await refreshOrderPayment({
      db,
      orderId,
      providers: services.payments.providers,
    });
    const statusText = payment.status === 'paid'
      ? 'Pagamento confirmado pelo provedor.'
      : payment.status === 'pending'
        ? 'O provedor ainda informa pagamento pendente.'
        : `Status atual: ${payment.status}.`;
    await interaction.reply({ content: statusText, ephemeral: true });
    return true;
  }

  if (action === 'support') {
    const recent = db.prepare(`
      SELECT details, created_at FROM audit_logs
      WHERE guild_id = ? AND actor_id = ? AND action = 'order.support_requested'
      ORDER BY id DESC LIMIT 20
    `).all(interaction.guildId, interaction.user.id);
    const duplicate = recent.some((entry) => {
      if (Date.now() - Date.parse(entry.created_at) > 60_000) {
        return false;
      }

      try {
        return JSON.parse(entry.details).orderId === orderId;
      } catch {
        return false;
      }
    });

    if (duplicate) {
      await interaction.reply({ content: 'A equipe já foi avisada recentemente.', ephemeral: true });
      return true;
    }

    const roleIds = getOperationalRoleIds(db, interaction.guildId, interaction.guild);
    await interaction.channel.send({
      content: [
        roleIds.map((id) => `<@&${id}>`).join(' '),
        `<@${interaction.user.id}> solicitou atendimento para o pedido \`${orderId}\`.`,
      ].filter(Boolean).join('\n'),
      allowedMentions: { roles: roleIds, users: [] },
    });
    writeAuditLog(db, interaction.guildId, interaction.user.id, 'order.support_requested', { orderId });
    await interaction.reply({ content: 'A equipe foi avisada neste ticket.', ephemeral: true });
    return true;
  }

  if (action === 'cancel') {
    if (interaction.user.id !== result.order.user_id) {
      await interaction.reply({ content: 'Somente o comprador pode cancelar este pedido.', ephemeral: true });
      return true;
    }

    const activePayment = db.prepare(`
      SELECT status FROM payments WHERE order_id = ?
        AND status IN ('creating', 'pending', 'paid', 'outcome_unknown')
      LIMIT 1
    `).get(orderId);
    if (activePayment) {
      await interaction.reply({
        content: 'Este pedido tem uma cobrança ativa ou confirmada. A equipe precisa resolver o pagamento antes do encerramento.',
        ephemeral: true,
      });
      return true;
    }

    closeOrderTicket(db, interaction.guildId, orderId, interaction.user.id);
    await interaction.channel.permissionOverwrites.edit(result.order.user_id, {
      SendMessages: false,
    });
    await interaction.channel.send('O comprador cancelou o pedido. Nenhum pagamento foi processado.');
    await interaction.reply({ content: 'Pedido cancelado e registrado.', ephemeral: true });
    return true;
  }

  if (action === 'close') {
    if (!isStaff(interaction, db)) {
      await interaction.reply({ content: 'Somente a equipe pode fechar este ticket.', ephemeral: true });
      return true;
    }
    const activePayment = db.prepare(`
      SELECT status FROM payments WHERE order_id = ?
        AND status IN ('creating', 'pending', 'paid', 'outcome_unknown')
      LIMIT 1
    `).get(orderId);
    if (activePayment) {
      await interaction.reply({
        content: 'Este pedido tem uma cobrança ativa ou confirmada. A equipe precisa resolver o pagamento antes do encerramento.',
        ephemeral: true,
      });
      return true;
    }
    closeOrderTicket(db, interaction.guildId, orderId, interaction.user.id);
    await interaction.channel.permissionOverwrites.edit(result.order.user_id, {
      SendMessages: false,
    });
    await interaction.channel.send('O ticket foi encerrado pela equipe. Nenhum pagamento foi processado.');
    await interaction.reply({ content: 'Pedido encerrado e registrado.', ephemeral: true });
    return true;
  }

  return false;
}

async function handleSupportButton(interaction, db) {
  if (interaction.customId === 'support:create') {
    await interaction.deferReply({ ephemeral: true });
    const result = await createSupportTicket({
      db,
      guild: interaction.guild,
      user: interaction.user,
      botUserId: interaction.client.user.id,
    });
    await interaction.editReply(
      `${result.duplicate ? 'Você já possui um atendimento aberto:' : 'Atendimento criado:'} ${result.channel}`,
    );
    return true;
  }

  const [, , ticketId] = interaction.customId.split(':');
  const ticket = db.prepare(
    'SELECT * FROM support_tickets WHERE id = ? AND guild_id = ?',
  ).get(ticketId, interaction.guildId);

  if (!ticket || ticket.channel_id !== interaction.channelId || ticket.status !== 'open') {
    await interaction.reply({ content: 'Este atendimento já foi encerrado ou não existe.', ephemeral: true });
    return true;
  }

  if (interaction.user.id !== ticket.user_id && !isStaff(interaction, db)) {
    await interaction.reply({ content: 'Você não tem permissão para fechar este atendimento.', ephemeral: true });
    return true;
  }

  closeSupportTicket(db, ticketId, interaction.user.id);
  await interaction.channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false });
  await interaction.channel.send('Este atendimento foi encerrado.');
  await interaction.reply({ content: 'Atendimento encerrado.', ephemeral: true });
  return true;
}

export async function handleComponentInteraction(interaction, services) {
  if (!isGuildInteraction(interaction)) {
    return false;
  }

  const { db } = services;
  const customId = interaction.customId;

  if (customId.startsWith('cfg:')) {
    return handleConfigurationComponent(interaction, services);
  }

  if (customId.startsWith('matrix:')) {
    return handleMatrixInteraction(interaction, services);
  }

  if (customId.startsWith('announcement:')) {
    return handleAnnouncementInteraction(interaction, db);
  }

  if (customId.startsWith('missions:')) {
    return handleMissionViewInteraction(interaction, db);
  }

  if (customId.startsWith('draft:')) {
    return handleDraftInteraction(interaction, db);
  }

  if (customId.startsWith('shop:page:')) {
    return handleShopPage(interaction, db);
  }

  if (interaction.isStringSelectMenu() && customId.startsWith('shop:')) {
    return handleShopSelect(interaction, db);
  }

  if (interaction.isStringSelectMenu() && customId === 'cart:edit') {
    return handleCartSelect(interaction, db);
  }

  if (interaction.isButton() && customId === 'cart:coupon') {
    await interaction.showModal(makeModal(
      'cart:coupon:apply',
      'Aplicar cupom',
      'code',
      'Código do cupom',
      { maxLength: 32 },
    ));
    return true;
  }

  if (interaction.isButton() && customId.startsWith('shop:add:')) {
    return handleProductAdd(interaction, db);
  }

  if (interaction.isButton() && customId === 'cart:checkout') {
    await interaction.deferReply({ ephemeral: true });
    const result = await createOrderTicket({
      db,
      guild: interaction.guild,
      user: interaction.user,
      botUserId: interaction.client.user.id,
    });
    if (!services.payments?.providers
      || !Object.keys(services.payments.providers).length) {
      await interaction.editReply([
        result.duplicate ? 'Seu pedido continua aberto:' : `Pedido \`${result.orderId}\` criado.`,
        'Nenhum provedor de pagamento está configurado.',
        result.channel,
      ].join('\n'));
      return true;
    }

    try {
      const payment = await createOrderPayment({
        db,
        orderId: result.orderId,
        payerName: interaction.user.globalName || interaction.user.username,
        providers: services.payments.providers,
        providerOrder: services.payments.providerOrder,
      });
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.orderId);
      await result.channel.send(buildPixMessage(payment, order));
      await interaction.editReply([
        result.duplicate ? `Pedido \`${result.orderId}\` já estava aberto.` : `Pedido \`${result.orderId}\` criado.`,
        payment.status === 'paid' ? 'Pagamento confirmado pelo provedor.' : 'Cobrança Pix pronta.',
        result.channel,
      ].join('\n'));
    } catch (error) {
      if (!(error instanceof PaymentError)) throw error;
      await result.channel.send(error.message);
      await interaction.editReply([
        `Pedido \`${result.orderId}\` permanece aberto.`,
        error.message,
        result.channel,
      ].join('\n'));
    }
    return true;
  }

  if (interaction.isButton() && customId.startsWith('order:')) {
    return handleOrderButton(interaction, services);
  }

  if (interaction.isButton() && customId.startsWith('support:')) {
    return handleSupportButton(interaction, db);
  }

  if (interaction.isButton() && customId.startsWith('shop:')) {
    return false;
  }

  return false;
}

export async function handleModalSubmit(interaction, services) {
  if (!isGuildInteraction(interaction)) {
    return false;
  }

  const { db } = services;
  const customId = interaction.customId;

  if (customId.startsWith('cfg:')) {
    return handleConfigurationModal(interaction, services);
  }

  if (customId.startsWith('shop:quantity:') || customId.startsWith('cart:quantity:')) {
    const [scope, , productId] = customId.split(':');
    const raw = interaction.fields.getTextInputValue('quantity').trim();

    if (!/^\d{1,3}$/.test(raw)) {
      throw new CommerceError('Informe uma quantidade inteira entre 1 e 99, ou 0 para remover.');
    }

    const quantity = Number(raw);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 99
      || (scope === 'shop' && quantity === 0)) {
      throw new CommerceError('A quantidade deve estar entre 1 e 99. Use o carrinho para remover itens.');
    }

    setCartItem(db, interaction.guildId, interaction.user.id, productId, quantity);
    await interaction.reply({
      ...buildCartView(db, interaction.guildId, interaction.user.id),
      ephemeral: true,
    });
    return true;
  }

  if (customId === 'cart:coupon:apply') {
    applyCartCoupon(
      db,
      interaction.guildId,
      interaction.user.id,
      interaction.fields.getTextInputValue('code'),
    );
    await interaction.reply({
      ...buildCartView(db, interaction.guildId, interaction.user.id),
      ephemeral: true,
    });
    return true;
  }

  if (customId.startsWith('inquiry:')) {
    const [, kind, productId] = customId.split(':');
    const product = db.prepare(`
      SELECT name, active, stock FROM products WHERE guild_id = ? AND id = ?
    `).get(interaction.guildId, productId);

    if (!product || !product.active || product.stock === 0) {
      throw new CommerceError('Este produto está indisponível.');
    }

    const value = interaction.fields.getTextInputValue(kind === 'robux' ? 'quantity' : 'details').trim();

    if (kind === 'robux' && (!/^\d{1,5}$/.test(value) || Number(value) < 100 || Number(value) > 17_000)) {
      throw new CommerceError('A quantidade de Robux deve ser um inteiro entre 100 e 17.000.');
    }

    if (kind === 'gamepass' && (!value || value.length > 500)) {
      throw new CommerceError('Informe qual GamePass deseja (até 500 caracteres).');
    }

    await interaction.deferReply({ ephemeral: true });
    const ticket = await createSupportTicket({
      db,
      guild: interaction.guild,
      user: interaction.user,
      botUserId: interaction.client.user.id,
    });
    await notifySupportRequest({
      db,
      guild: interaction.guild,
      channel: ticket.channel,
      userId: interaction.user.id,
      productId,
      notifyFounder: kind === 'gamepass',
      details: kind === 'robux'
        ? `Solicita **${value} Robux**. A equipe precisa confirmar o custo antes de criar um pedido.`
        : `Solicita o GamePass: **${value}**. A equipe precisa confirmar o preço antes de criar um pedido.`,
    });
    await interaction.editReply(`Sua solicitação foi encaminhada para ${ticket.channel}. Nenhum pedido ou pagamento foi criado.`);
    return true;
  }

  return false;
}
