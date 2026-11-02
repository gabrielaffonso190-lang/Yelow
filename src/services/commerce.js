import { randomUUID } from 'node:crypto';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  getGuildSettings,
  withTransaction,
  writeAuditLog,
} from './db.js';
import { getOperationalRoleIds } from './permissions.js';

const maximumQuantity = 99;

export class CommerceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommerceError';
  }
}

export function formatMoney(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(cents / 100);
}

export function calculateSalePrice(costCents) {
  if (!Number.isSafeInteger(costCents) || costCents <= 0) {
    throw new CommerceError('O custo do fornecedor deve ser um valor positivo em centavos.');
  }

  const price = Math.round(costCents * 1.3);
  if (!Number.isSafeInteger(price)) {
    throw new CommerceError('O preço calculado excede o limite permitido.');
  }

  return price;
}

export function listProducts(db, guildId, search = '') {
  const term = search.trim();

  if (!term) {
    return db.prepare(`
      SELECT id, name, description, category, price_cents, cost_cents, stock
      FROM products
      WHERE guild_id = ? AND active = 1
      ORDER BY category, name
      LIMIT 100
    `).all(guildId);
  }

  return db.prepare(`
    SELECT id, name, description, category, price_cents, cost_cents, stock
    FROM products
    WHERE guild_id = ? AND active = 1
      AND (name LIKE ? OR description LIKE ? OR category LIKE ?)
    ORDER BY category, name
    LIMIT 100
  `).all(guildId, `%${term}%`, `%${term}%`, `%${term}%`);
}

export const DEFAULT_CATALOG_PRODUCTS = [
    ['Spotify Premium — 1 mês', 'Spotify Premium', 'Assinatura com duração de 1 mês.', 20],
    ['Spotify Premium — 3 meses', 'Spotify Premium', 'Assinatura com duração de 3 meses.', 43],
    ['Spotify Premium — anual', 'Spotify Premium', 'Assinatura anual.', 6],
    ['Conta Spotify — 1 mês', 'Contas Spotify', 'Conta Spotify com duração de 1 mês.', 5],
    ['Conta Spotify — 3 meses', 'Contas Spotify', 'Conta Spotify com duração de 3 meses.', 0],
    ['YouTube Premium por link — 1 mês', 'YouTube Premium', 'Ativação por link com duração de 1 mês.', 33],
    ['YouTube Premium na própria conta — 1 mês', 'YouTube Premium', 'Ativação na própria conta com duração de 1 mês.', 4],
    ['Robux', 'Robux', 'Solicite entre 100 e 17.000 Robux. O custo para a quantidade escolhida precisa ser confirmado pela equipe.', 5],
    ['Discord Nitro', 'Discord Nitro', 'Duração, preço e disponibilidade precisam ser confirmados pela equipe.', 5],
    ...Array.from({ length: 12 }, (_, index) => {
      const year = 2015 + index;
      return [`Conta Discord — ${year}`, 'Contas Discord', `Conta do ano ${year}; preço e disponibilidade sujeitos a confirmação.`, 5];
    }),
    ...[2, 4, 6, 14].map((boosts) => [
      `Impulsos de servidor — ${boosts}x`,
      'Impulsos de servidor',
      `${boosts} impulsos. A duração precisa ser confirmada pela equipe.`,
      5,
    ]),
    ['GamePass — solicitação personalizada', 'GamePass', 'Informe qual GamePass deseja. A equipe confirma o preço antes de qualquer pagamento.', 5],
];

export function ensureDefaultCatalog(db, guildId) {
  const products = DEFAULT_CATALOG_PRODUCTS;
  const insert = db.prepare(`
    INSERT INTO products
      (id, guild_id, name, description, category, price_cents, stock, active, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)
    ON CONFLICT(guild_id, name) DO NOTHING
  `);
  const now = new Date().toISOString();

  return withTransaction(db, () => {
    let inserted = 0;
    for (const [name, category, description, stock] of products) {
      inserted += Number(insert.run(
        randomUUID(),
        guildId,
        name,
        description,
        category,
        stock,
        now,
      ).changes);
    }

    return inserted;
  });
}

export function getCart(db, guildId, userId) {
  const items = db.prepare(`
    SELECT ci.product_id, p.name, p.description, p.active, p.stock,
      ci.quantity, ci.unit_price_cents, p.price_cents
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id AND p.guild_id = ci.guild_id
    WHERE ci.guild_id = ? AND ci.user_id = ?
    ORDER BY p.name
  `).all(guildId, userId);
  const subtotalCents = items.reduce(
    (total, item) => total + item.unit_price_cents * item.quantity,
    0,
  );
  const cart = db.prepare(
    'SELECT coupon_code, checkout_order_id FROM carts WHERE guild_id = ? AND user_id = ?',
  ).get(guildId, userId);

  return {
    items,
    subtotalCents,
    couponCode: cart?.coupon_code ?? null,
    checkoutOrderId: cart?.checkout_order_id ?? null,
  };
}

function getCouponDiscount(db, guildId, code, subtotalCents, now = new Date()) {
  if (!code) {
    return { discountCents: 0, coupon: null };
  }

  const coupon = db.prepare(`
    SELECT * FROM coupons WHERE guild_id = ? AND code = ? AND active = 1
  `).get(guildId, code.toUpperCase());

  if (!coupon) {
    throw new CommerceError('Cupom inexistente ou inativo.');
  }

  const timestamp = now.toISOString();

  if ((coupon.valid_from && coupon.valid_from > timestamp)
    || (coupon.valid_until && coupon.valid_until < timestamp)) {
    throw new CommerceError('Este cupom está fora do período de validade.');
  }

  if (subtotalCents < coupon.min_cents) {
    throw new CommerceError(`O pedido mínimo para este cupom é ${formatMoney(coupon.min_cents)}.`);
  }

  const uses = db.prepare(
    'SELECT COUNT(*) AS count FROM coupon_uses WHERE guild_id = ? AND coupon_id = ?',
  ).get(guildId, coupon.id).count;

  if (coupon.max_uses !== null && uses >= coupon.max_uses) {
    throw new CommerceError('Este cupom atingiu o limite de utilizações.');
  }

  const discountCents = coupon.discount_type === 'percent'
    ? Math.floor(subtotalCents * coupon.discount_value / 100)
    : coupon.discount_value;

  return { discountCents: Math.min(subtotalCents, discountCents), coupon };
}

export function setCartItem(db, guildId, userId, productId, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > maximumQuantity) {
    throw new CommerceError('A quantidade deve estar entre 1 e 99, ou ser 0 para remover.');
  }

  const cart = db.prepare(`
    SELECT checkout_order_id FROM carts WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId);

  if (cart?.checkout_order_id) {
    throw new CommerceError('O carrinho está vinculado a um pedido em atendimento.');
  }

  const product = quantity === 0 ? null : db.prepare(`
    SELECT id, price_cents, cost_cents, stock FROM products
    WHERE guild_id = ? AND id = ? AND active = 1
  `).get(guildId, productId);

  if (quantity > 0 && (!product || product.cost_cents === null)) {
    throw new CommerceError('Produto indisponível.');
  }

  if (quantity > 0 && product.stock !== null) {
    const reserved = db.prepare(`
      SELECT COALESCE(SUM(ir.quantity), 0) AS quantity
      FROM inventory_reservations ir
      JOIN orders o ON o.id = ir.order_id
      WHERE ir.product_id = ? AND o.guild_id = ? AND o.status IN ('pending', 'in_service')
    `).get(productId, guildId).quantity;

    if (quantity + reserved > product.stock) {
      throw new CommerceError('A quantidade solicitada excede o estoque disponível.');
    }
  }

  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO carts (guild_id, user_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(guildId, userId, new Date().toISOString());

    if (quantity === 0) {
      db.prepare(`
        DELETE FROM cart_items WHERE guild_id = ? AND user_id = ? AND product_id = ?
      `).run(guildId, userId, productId);
    } else {
      db.prepare(`
        INSERT INTO cart_items (guild_id, user_id, product_id, quantity, unit_price_cents)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id, product_id) DO UPDATE SET
          quantity = excluded.quantity,
          unit_price_cents = excluded.unit_price_cents
      `).run(guildId, userId, productId, quantity, product.price_cents);
    }

    db.prepare(`
      UPDATE carts SET updated_at = ? WHERE guild_id = ? AND user_id = ?
    `).run(new Date().toISOString(), guildId, userId);
  });
}

export function applyCartCoupon(db, guildId, userId, code) {
  const normalized = code.trim().toUpperCase();

  if (!/^[A-Z0-9_-]{2,32}$/.test(normalized)) {
    throw new CommerceError('Código de cupom inválido.');
  }

  const cart = getCart(db, guildId, userId);

  if (cart.items.length === 0) {
    throw new CommerceError('Adicione produtos ao carrinho antes de usar um cupom.');
  }

  getCouponDiscount(db, guildId, normalized, cart.subtotalCents);
  db.prepare(`
    UPDATE carts SET coupon_code = ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(normalized, new Date().toISOString(), guildId, userId);
}

export function getCartTotals(db, guildId, userId) {
  const cart = getCart(db, guildId, userId);
  const { discountCents } = getCouponDiscount(
    db,
    guildId,
    cart.couponCode,
    cart.subtotalCents,
  );

  return {
    ...cart,
    discountCents,
    totalCents: Math.max(0, cart.subtotalCents - discountCents),
  };
}

function reserveOrder(db, guildId, userId) {
  return withTransaction(db, () => {
    const cartRow = db.prepare(
      'SELECT * FROM carts WHERE guild_id = ? AND user_id = ?',
    ).get(guildId, userId);

    if (!cartRow) {
      throw new CommerceError('Seu carrinho está vazio.');
    }

    if (cartRow.checkout_order_id) {
      const existing = db.prepare(`
        SELECT o.id, o.status, t.channel_id, t.status AS ticket_status
        FROM orders o LEFT JOIN tickets t ON t.order_id = o.id
        WHERE o.id = ? AND o.guild_id = ? AND o.user_id = ?
      `).get(cartRow.checkout_order_id, guildId, userId);

      if (existing && existing.status !== 'cancelled') {
        if (existing.ticket_status === 'creating') {
          throw new CommerceError('Seu pedido está sendo processado. Aguarde um instante.');
        }

        return { orderId: existing.id, existing };
      }

      db.prepare(`
        UPDATE carts SET checkout_order_id = NULL
        WHERE guild_id = ? AND user_id = ?
      `).run(guildId, userId);
    }

    const items = db.prepare(`
      SELECT ci.product_id, ci.quantity, p.name, p.price_cents, p.cost_cents, p.stock, p.active
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id AND p.guild_id = ci.guild_id
      WHERE ci.guild_id = ? AND ci.user_id = ?
    `).all(guildId, userId);

    if (items.length === 0) {
      throw new CommerceError('Seu carrinho está vazio.');
    }

    for (const item of items) {
      if (!item.active || item.cost_cents === null
        || item.price_cents !== Math.round(item.cost_cents * 1.3)
        || item.price_cents !== db.prepare(
        'SELECT unit_price_cents FROM cart_items WHERE guild_id = ? AND user_id = ? AND product_id = ?',
      ).get(guildId, userId, item.product_id).unit_price_cents) {
        throw new CommerceError('Um produto ou preço mudou. Revise seu carrinho antes de confirmar.');
      }

      if (item.stock !== null) {
        const reserved = db.prepare(`
          SELECT COALESCE(SUM(ir.quantity), 0) AS quantity
          FROM inventory_reservations ir JOIN orders o ON o.id = ir.order_id
          WHERE ir.product_id = ? AND o.guild_id = ? AND o.status IN ('pending', 'in_service')
        `).get(item.product_id, guildId).quantity;

        if (item.quantity + reserved > item.stock) {
          throw new CommerceError(`Estoque insuficiente para ${item.name}.`);
        }
      }
    }

    const subtotalCents = items.reduce(
      (total, item) => total + item.price_cents * item.quantity,
      0,
    );
    const { discountCents, coupon } = getCouponDiscount(
      db,
      guildId,
      cartRow.coupon_code,
      subtotalCents,
    );
    const orderId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO orders
        (id, guild_id, user_id, status, subtotal_cents, discount_cents, total_cents, coupon_code, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      orderId,
      guildId,
      userId,
      subtotalCents,
      discountCents,
      Math.max(0, subtotalCents - discountCents),
      coupon?.code ?? null,
      now,
    );

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity)
      VALUES (?, ?, ?, ?, ?)
    `);
    const reserve = db.prepare(`
      INSERT INTO inventory_reservations (order_id, product_id, quantity) VALUES (?, ?, ?)
    `);

    for (const item of items) {
      insertItem.run(orderId, item.product_id, item.name, item.price_cents, item.quantity);
      if (item.stock !== null) {
        reserve.run(orderId, item.product_id, item.quantity);
      }
    }

    db.prepare(`
      INSERT INTO tickets (order_id, guild_id, status, opened_at)
      VALUES (?, ?, 'creating', ?)
    `).run(orderId, guildId, now);

    if (coupon) {
      db.prepare(`
        INSERT INTO coupon_uses (guild_id, coupon_id, coupon_code, order_id, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(guildId, coupon.id, coupon.code, orderId, userId, now);
    }

    db.prepare(`
      UPDATE carts SET checkout_order_id = ?, updated_at = ?
      WHERE guild_id = ? AND user_id = ?
    `).run(orderId, now, guildId, userId);

    writeAuditLog(db, guildId, userId, 'order.created', { orderId });
    return { orderId };
  });
}

function ticketOverwrites(guild, userId, botUserId, staffRoleIds) {
  const overwrite = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
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
      ],
    },
    ...staffRoleIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];

  return overwrite;
}

export async function createOrderTicket({ db, guild, user, botUserId }) {
  const reservation = reserveOrder(db, guild.id, user.id);
  const ticket = reservation.existing
    ? reservation.existing
    : db.prepare('SELECT * FROM tickets WHERE order_id = ?').get(reservation.orderId);

  const isTicketOpen = reservation.existing
    ? ticket.ticket_status === 'open'
    : ticket.status === 'open';

  if (isTicketOpen && ticket.channel_id) {
    const existingChannel = await guild.channels.fetch(ticket.channel_id).catch((error) => {
      if (error?.code === 10003) {
        return null;
      }

      throw error;
    });
    if (existingChannel) {
      return { orderId: reservation.orderId, channel: existingChannel, duplicate: true };
    }
  }

  const { settings } = getGuildSettings(db, guild.id);
  const allowedStaffRoles = getOperationalRoleIds(db, guild.id, guild);
  const orderIdShort = reservation.orderId.slice(0, 8);

  let channel;
  try {
    channel = await guild.channels.create({
      name: `pedido-${orderIdShort}`,
      type: ChannelType.GuildText,
      ...(settings.ticketCategoryId ? { parent: settings.ticketCategoryId } : {}),
      permissionOverwrites: ticketOverwrites(guild, user.id, botUserId, allowedStaffRoles),
      reason: `Atendimento para pedido ${orderIdShort}`,
    });

    db.prepare(`
      UPDATE tickets SET channel_id = ?, status = 'open' WHERE order_id = ?
    `).run(channel.id, reservation.orderId);
    db.prepare(`
      UPDATE orders SET status = 'in_service' WHERE id = ?
    `).run(reservation.orderId);
    writeAuditLog(db, guild.id, user.id, 'ticket.opened', {
      orderId: reservation.orderId,
      channelId: channel.id,
    });

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(reservation.orderId);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?')
      .all(reservation.orderId);
    const lines = items.map((item) => (
      `• ${item.product_name} × ${item.quantity} — ${formatMoney(item.unit_price_cents * item.quantity)}`
    ));

    await channel.send({
      content: [
        allowedStaffRoles.map((id) => `<@&${id}>`).join(' '),
        `Pedido \`${reservation.orderId}\` de <@${user.id}>`,
        ...lines,
        `Subtotal: ${formatMoney(order.subtotal_cents)}`,
        `Desconto: ${formatMoney(order.discount_cents)}`,
        `Total: ${formatMoney(order.total_cents)}`,
        '',
        'Status: aguardando atendimento. O pagamento só será confirmado após validação pelo provedor.',
      ].filter(Boolean).join('\n'),
      allowedMentions: { users: [user.id], roles: allowedStaffRoles },
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`order:refresh:${reservation.orderId}`)
          .setLabel('Atualizar pedido')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`order:support:${reservation.orderId}`)
          .setLabel('Solicitar suporte')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`order:cancel:${reservation.orderId}`)
          .setLabel('Cancelar pedido')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`order:close:${reservation.orderId}`)
          .setLabel('Fechar pedido')
          .setStyle(ButtonStyle.Danger),
      )],
    });

    return { orderId: reservation.orderId, channel, duplicate: false };
  } catch (error) {
    let cleanupFailed = false;

    if (channel) {
      try {
        await channel.delete('Falha ao concluir a abertura do ticket');
      } catch (cleanupError) {
        cleanupFailed = true;
        console.error(`Falha ao limpar canal de pedido (${cleanupError.name || 'UnknownError'}).`);
      }
    }

    if (!reservation.existing) {
      withTransaction(db, () => {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?")
          .run(reservation.orderId);
        db.prepare(`
          UPDATE tickets SET status = 'closed', closed_at = ?, channel_id = NULL
          WHERE order_id = ?
        `).run(new Date().toISOString(), reservation.orderId);
        if (cleanupFailed && channel) {
          db.prepare('UPDATE tickets SET channel_id = ? WHERE order_id = ?')
            .run(channel.id, reservation.orderId);
        }
        db.prepare('DELETE FROM coupon_uses WHERE order_id = ?').run(reservation.orderId);
        db.prepare(`
          UPDATE carts SET checkout_order_id = NULL
          WHERE guild_id = ? AND user_id = ? AND checkout_order_id = ?
        `).run(guild.id, user.id, reservation.orderId);
        writeAuditLog(db, guild.id, user.id, 'ticket.creation_failed', {
          orderId: reservation.orderId,
        });
      });
    }

    throw error;
  }
}

export function closeOrderTicket(db, guildId, orderId, actorId) {
  const ticket = db.prepare(
    'SELECT * FROM tickets WHERE order_id = ? AND guild_id = ? AND status = ?',
  ).get(orderId, guildId, 'open');

  if (!ticket) {
    throw new CommerceError('Este ticket já foi encerrado ou não existe.');
  }

  withTransaction(db, () => {
    const activePayment = db.prepare(`
      SELECT status FROM payments WHERE order_id = ?
        AND status IN ('creating', 'pending', 'paid', 'outcome_unknown')
      LIMIT 1
    `).get(orderId);
    if (activePayment) {
      throw new CommerceError(
        'O pedido tem uma cobrança ativa ou confirmada. A equipe deve resolver o pagamento antes de encerrar.',
      );
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tickets SET status = 'closed', closed_at = ? WHERE order_id = ?
    `).run(now, orderId);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(orderId);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'in_service'")
      .run(orderId);
    db.prepare('DELETE FROM inventory_reservations WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM coupon_uses WHERE order_id = ?').run(orderId);
    db.prepare(`
      UPDATE carts SET checkout_order_id = NULL
      WHERE guild_id = ? AND checkout_order_id = ?
    `).run(guildId, orderId);
    writeAuditLog(db, guildId, actorId, 'ticket.closed', { orderId });
  });

  return ticket;
}

export function createCoupon(db, {
  guildId,
  code,
  discountType,
  discountValue,
  validFrom = null,
  validUntil = null,
  maxUses = null,
  minCents = 0,
  createdBy,
}) {
  const normalized = code.trim().toUpperCase();

  if (!/^[A-Z0-9_-]{2,32}$/.test(normalized)) {
    throw new CommerceError('Código deve ter 2 a 32 letras, números, hífens ou sublinhados.');
  }

  if (!['percent', 'fixed'].includes(discountType)
    || !Number.isSafeInteger(discountValue)
    || discountValue <= 0
    || (discountType === 'percent' && discountValue > 100)
    || (discountType === 'fixed' && discountValue > 100_000_000)
    || (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1))
    || !Number.isSafeInteger(minCents)
    || minCents < 0
    || (validFrom && Number.isNaN(Date.parse(validFrom)))
    || (validUntil && Number.isNaN(Date.parse(validUntil)))
    || (validFrom && validUntil && Date.parse(validFrom) >= Date.parse(validUntil))) {
    throw new CommerceError('Os parâmetros do cupom são inválidos.');
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO coupons
      (id, guild_id, code, discount_type, discount_value, valid_from, valid_until,
       max_uses, min_cents, active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    id,
    guildId,
    normalized,
    discountType,
    discountValue,
    validFrom,
    validUntil,
    maxUses,
    minCents,
    createdBy,
  );
  writeAuditLog(db, guildId, createdBy, 'coupon.created', { code: normalized });

  return id;
}

export function updateCoupon(db, guildId, code, {
  discountType,
  discountValue,
  validUntil = null,
  maxUses = null,
  minCents = 0,
}) {
  const normalized = code.toUpperCase();
  const coupon = db.prepare(`
    SELECT id FROM coupons WHERE guild_id = ? AND code = ?
  `).get(guildId, normalized);

  if (!coupon) {
    throw new CommerceError('Cupom não encontrado.');
  }

  if (!['percent', 'fixed'].includes(discountType)
    || !Number.isSafeInteger(discountValue)
    || discountValue <= 0
    || (discountType === 'percent' && discountValue > 100)
    || (discountType === 'fixed' && discountValue > 100_000_000)
    || (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1))
    || !Number.isSafeInteger(minCents)
    || minCents < 0
    || (validUntil && Number.isNaN(Date.parse(validUntil)))) {
    throw new CommerceError('Os parâmetros do cupom são inválidos.');
  }

  const used = db.prepare(
    'SELECT COUNT(*) AS count FROM coupon_uses WHERE guild_id = ? AND coupon_id = ?',
  ).get(guildId, coupon.id).count;

  if (maxUses !== null && maxUses < used) {
    throw new CommerceError('O limite não pode ser menor que as utilizações já registradas.');
  }

  db.prepare(`
    UPDATE coupons SET discount_type = ?, discount_value = ?, valid_until = ?,
      max_uses = ?, min_cents = ? WHERE guild_id = ? AND code = ?
  `).run(discountType, discountValue, validUntil, maxUses, minCents, guildId, normalized);
}

export function deleteCoupon(db, guildId, code) {
  return db.prepare('DELETE FROM coupons WHERE guild_id = ? AND code = ?')
    .run(guildId, code.toUpperCase()).changes > 0;
}
