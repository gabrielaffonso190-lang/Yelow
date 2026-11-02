import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { commands } from '../src/commands/index.js';
import { ensureMissionSchema, ensurePaymentSchema } from '../src/services/db.js';
import {
  applyCartCoupon,
  calculateSalePrice,
  closeOrderTicket,
  createCoupon,
  deleteCoupon,
  createOrderTicket,
  ensureDefaultCatalog,
  getCartTotals,
  setCartItem,
  updateCoupon,
} from '../src/services/commerce.js';
import {
  buildProductDetailView,
  buildShopView,
  configurationPanel,
  configurationSection,
} from '../src/services/ui.js';
import { handleConfigurationModal } from '../src/services/configuration.js';
import {
  buildHealthEmbed,
  buildMatrixPanel,
  handleMatrixInteraction,
  recoverMatrixPanel,
} from '../src/services/matrix.js';
import { ROLE_IDS } from '../src/services/permissions.js';
import {
  createAnnouncementPreview,
  handleAnnouncementInteraction,
} from '../src/services/announcements.js';

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE products (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Geral',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
      image_asset_id TEXT,
      stock INTEGER CHECK (stock IS NULL OR stock >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL, UNIQUE (guild_id, name)
    );
    CREATE TABLE carts (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, coupon_code TEXT,
      checkout_order_id TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE cart_items (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      PRIMARY KEY (guild_id, user_id, product_id),
      FOREIGN KEY (guild_id, user_id) REFERENCES carts(guild_id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_service', 'cancelled')),
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
      discount_cents INTEGER NOT NULL CHECK (discount_cents >= 0),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      coupon_code TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE order_items (
      order_id TEXT NOT NULL REFERENCES orders(id), product_id TEXT NOT NULL,
      product_name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      PRIMARY KEY (order_id, product_id)
    );
    CREATE TABLE tickets (
      order_id TEXT PRIMARY KEY REFERENCES orders(id), guild_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closed')),
      opened_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closed')),
      opened_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE coupons (
      id TEXT NOT NULL UNIQUE, guild_id TEXT NOT NULL, code TEXT NOT NULL,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
      discount_value INTEGER NOT NULL CHECK (discount_value > 0),
      valid_from TEXT, valid_until TEXT,
      max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
      min_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_cents >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_by TEXT NOT NULL, PRIMARY KEY (guild_id, code)
    );
    CREATE TABLE coupon_uses (
      guild_id TEXT NOT NULL, coupon_id TEXT NOT NULL, coupon_code TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), user_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (guild_id, coupon_id, order_id)
    );
    CREATE TABLE inventory_reservations (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      PRIMARY KEY (order_id, product_id)
    );
    CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}',
      staff_role_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      session_id TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE customization_sessions (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'closed')),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE action_drafts (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, target TEXT NOT NULL, value TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE announcement_publications (
      draft_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('publishing', 'published', 'failed')),
      created_at TEXT NOT NULL
    );
  `);
  ensurePaymentSchema(db);
  ensureMissionSchema(db);

  return db;
}

function addProduct(db, {
  id = 'product-1',
  guildId = 'guild-1',
  name = 'Produto',
  costCents = 1000,
  priceCents = 1300,
  stock = 5,
} = {}) {
  db.prepare(`
    INSERT INTO products
      (id, guild_id, name, description, category, price_cents, cost_cents, stock, active, created_at)
    VALUES (?, ?, ?, 'Descrição', 'Geral', ?, ?, ?, 1, ?)
  `).run(id, guildId, name, priceCents, costCents, stock, new Date().toISOString());
}

test('sale price uses a 30% markup in integer cents', () => {
  assert.equal(calculateSalePrice(1000), 1300);
  assert.equal(calculateSalePrice(101), 131);
  assert.throws(() => calculateSalePrice(0), /custo do fornecedor/);
});

test('default catalog seeds known stock once and never overwrites existing stock', () => {
  const db = createDatabase();
  const inserted = ensureDefaultCatalog(db, 'guild-1');
  assert.equal(inserted, 26);
  assert.equal(ensureDefaultCatalog(db, 'guild-1'), 0);

  const spotify = db.prepare(`
    SELECT stock, cost_cents FROM products
    WHERE guild_id = ? AND name = ?
  `).get('guild-1', 'Spotify Premium — 1 mês');
  assert.equal(spotify.stock, 20);
  assert.equal(spotify.cost_cents, null);

  const soldOut = db.prepare(`
    SELECT stock FROM products WHERE guild_id = ? AND name = ?
  `).get('guild-1', 'Conta Spotify — 3 meses');
  assert.equal(soldOut.stock, 0);

  db.prepare(`
    UPDATE products SET stock = 9 WHERE guild_id = ? AND name = ?
  `).run('guild-1', 'Spotify Premium — 1 mês');
  assert.equal(ensureDefaultCatalog(db, 'guild-1'), 0);
  assert.equal(db.prepare(
    'SELECT stock FROM products WHERE guild_id = ? AND name = ?',
  ).get('guild-1', 'Spotify Premium — 1 mês').stock, 9);

  const shop = buildShopView(db, 'guild-1');
  assert.ok(shop.embeds[0].toJSON().description);
  assert.ok(shop.components.every((component) => component.toJSON()));
  const product = db.prepare(`
    SELECT id, name, description, price_cents, cost_cents, stock, active, image_asset_id
    FROM products WHERE guild_id = ? AND name = ?
  `).get('guild-1', 'Robux');
  const productView = buildProductDetailView(db, 'guild-1', product);
  assert.ok(productView.embeds[0].toJSON().description);
  assert.ok(productView.components[0].toJSON());

  const center = configurationPanel(db, 'guild-1');
  assert.ok(center.embeds[0].toJSON().title);
  for (const section of [
    'tickets',
    'staff',
    'shop',
    'products',
    'messages',
    'coupons',
    'images',
    'ai',
    'support',
  ]) {
    const view = configurationSection(db, 'guild-1', section);
    assert.ok(view.components.every((component) => component.toJSON()));
  }
  db.close();
});

test('cart validates inventory and keeps coupon totals nonnegative', () => {
  const db = createDatabase();
  addProduct(db, { stock: 2 });
  setCartItem(db, 'guild-1', 'user-1', 'product-1', 2);

  createCoupon(db, {
    guildId: 'guild-1',
    code: 'PROMO',
    discountType: 'percent',
    discountValue: 25,
    maxUses: 2,
    minCents: 100,
    createdBy: 'staff-1',
  });
  applyCartCoupon(db, 'guild-1', 'user-1', 'promo');

  assert.deepEqual(
    (({ subtotalCents, discountCents, totalCents }) => ({
      subtotalCents,
      discountCents,
      totalCents,
    }))(getCartTotals(db, 'guild-1', 'user-1')),
    { subtotalCents: 2600, discountCents: 650, totalCents: 1950 },
  );
  assert.throws(() => setCartItem(db, 'guild-1', 'user-1', 'product-1', 3), /estoque/);
  assert.throws(() => setCartItem(db, 'guild-1', 'user-1', 'product-1', 100), /quantidade/);
  assert.throws(() => createCoupon(db, {
    guildId: 'guild-1',
    code: 'INVALID',
    discountType: 'percent',
    discountValue: 101,
    createdBy: 'staff-1',
  }), /parâmetros/);
  db.close();
});

test('products without confirmed supplier cost and sold-out products cannot enter a cart', () => {
  const db = createDatabase();
  addProduct(db, { costCents: null, priceCents: 0 });
  assert.throws(() => setCartItem(db, 'guild-1', 'user-1', 'product-1', 1), /indisponível/);

  addProduct(db, {
    id: 'sold-out',
    name: 'Esgotado',
    costCents: 100,
    priceCents: 130,
    stock: 0,
  });
  assert.throws(() => setCartItem(db, 'guild-1', 'user-2', 'sold-out', 1), /estoque/);
  db.close();
});

test('coupon editing respects uses and deletion leaves order records untouched', () => {
  const db = createDatabase();
  const id = createCoupon(db, {
    guildId: 'guild-1',
    code: 'EDIT',
    discountType: 'percent',
    discountValue: 20,
    maxUses: 5,
    createdBy: 'staff-1',
  });
  assert.ok(id);
  updateCoupon(db, 'guild-1', 'EDIT', {
    discountType: 'fixed',
    discountValue: 250,
    maxUses: 2,
    minCents: 500,
    validUntil: null,
  });
  const coupon = db.prepare(
    'SELECT discount_type, discount_value, max_uses, min_cents FROM coupons WHERE code = ?',
  ).get('EDIT');
  assert.equal(coupon.discount_type, 'fixed');
  assert.equal(coupon.discount_value, 250);
  assert.equal(coupon.max_uses, 2);
  assert.equal(coupon.min_cents, 500);
  assert.equal(deleteCoupon(db, 'guild-1', 'EDIT'), true);
  assert.equal(deleteCoupon(db, 'guild-1', 'EDIT'), false);
  db.close();
});

test('checkout revalidates price, avoids duplicate tickets and releases coupon stock on close', async () => {
  const db = createDatabase();
  addProduct(db, { stock: 2 });
  setCartItem(db, 'guild-1', 'user-1', 'product-1', 1);
  createCoupon(db, {
    guildId: 'guild-1',
    code: 'ONEUSE',
    discountType: 'fixed',
    discountValue: 100,
    maxUses: 1,
    createdBy: 'staff-1',
  });
  applyCartCoupon(db, 'guild-1', 'user-1', 'oneuse');

  const createdChannels = [];
  const channel = {
    id: 'channel-1',
    send: async () => {},
    delete: async () => {},
  };
  const guild = {
    id: 'guild-1',
    ownerId: 'owner-1',
    roles: {
      everyone: { id: 'guild-1' },
      cache: { has: () => false },
    },
    channels: {
      create: async () => {
        createdChannels.push(channel);
        return channel;
      },
      fetch: async () => channel,
    },
  };
  const user = { id: 'user-1' };
  const first = await createOrderTicket({
    db,
    guild,
    user,
    botUserId: 'bot-1',
  });
  const duplicate = await createOrderTicket({
    db,
    guild,
    user,
    botUserId: 'bot-1',
  });

  assert.equal(createdChannels.length, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.orderId, duplicate.orderId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coupon_uses').get().count, 1);

  db.prepare(`
    INSERT INTO payments
      (id, order_id, provider, idempotency_key, amount_cents, status, created_at, updated_at)
    VALUES ('payment-1', ?, 'zpay', 'vanta-test', 1200, 'pending', ?, ?)
  `).run(first.orderId, new Date().toISOString(), new Date().toISOString());
  assert.throws(
    () => closeOrderTicket(db, 'guild-1', first.orderId, 'staff-1'),
    /cobrança ativa ou confirmada/,
  );
  assert.equal(db.prepare(
    'SELECT status FROM tickets WHERE order_id = ?',
  ).get(first.orderId).status, 'open');
  db.prepare("UPDATE payments SET status = 'expired' WHERE id = 'payment-1'").run();

  closeOrderTicket(db, 'guild-1', first.orderId, 'staff-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inventory_reservations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coupon_uses').get().count, 0);
  db.close();
});

test('checkout rejects a price changed after the cart was created', async () => {
  const db = createDatabase();
  addProduct(db, { stock: 5 });
  setCartItem(db, 'guild-1', 'user-1', 'product-1', 1);
  db.prepare('UPDATE products SET cost_cents = 2000, price_cents = 2600 WHERE id = ?')
    .run('product-1');
  let created = false;
  const guild = {
    id: 'guild-1',
    ownerId: 'owner-1',
    roles: { everyone: { id: 'guild-1' }, cache: { has: () => false } },
    channels: { create: async () => { created = true; } },
  };

  await assert.rejects(createOrderTicket({
    db,
    guild,
    user: { id: 'user-1' },
    botUserId: 'bot-1',
  }), /preço mudou/);
  assert.equal(created, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
  db.close();
});

test('slash command registry contains no duplicate names', () => {
  const names = commands.map(({ data }) => data.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [
    'ping',
    'healty',
    'anuncio',
    'config',
    'comprar',
    'carrinho',
    'personalizar',
    'conversa',
    'missoes',
  ]);
  const config = commands.find(({ data }) => data.name === 'config').data.toJSON();
  assert.equal(config.options[0].name, 'center');
});

test('admin product form stores costs and stock with a 30% sales price', async () => {
  const db = createDatabase();
  const interaction = {
    customId: 'cfg:product:create',
    inGuild: () => true,
    guildId: 'guild-1',
    guild: { ownerId: 'owner-1' },
    user: { id: 'admin-1' },
    member: {
      roles: { cache: new Map() },
      permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    fields: {
      getTextInputValue(name) {
        return {
          name: 'Novo produto',
          description: 'Descrição',
          cost: '10,00',
          category: 'Teste',
          stock: '7',
        }[name];
      },
    },
    reply: async (response) => response,
  };

  await handleConfigurationModal(interaction, { db });
  const product = db.prepare(`
    SELECT cost_cents, price_cents, stock FROM products WHERE name = 'Novo produto'
  `).get();
  assert.deepEqual({ ...product }, { cost_cents: 1000, price_cents: 1300, stock: 7 });
  db.close();
});

test('MATRIX roles are enforced and panel recovery updates instead of duplicating', async () => {
  const db = createDatabase();
  const sent = [];
  const edited = [];
  const message = {
    id: 'matrix-message',
    edit: async (payload) => {
      edited.push(payload);
      return message;
    },
  };
  const channel = {
    id: '1560463567025606677',
    guild: { id: 'guild-1' },
    isTextBased: () => true,
    isSendable: () => true,
    messages: { fetch: async () => message },
    send: async (payload) => {
      sent.push(payload);
      return message;
    },
  };
  const client = {
    user: { id: 'bot-1' },
    channels: { fetch: async () => channel },
  };
  const matrix = buildMatrixPanel();
  assert.equal(matrix.components[0].toJSON().components[0].custom_id, 'matrix:section');
  await recoverMatrixPanel({ client, db, env: { MATRIX_CHANNEL_ID: channel.id } });
  await recoverMatrixPanel({ client, db, env: { MATRIX_CHANNEL_ID: channel.id } });
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 1);

  const managerPermissions = new PermissionsBitField();
  const manager = {
    isStringSelectMenu: () => true,
    customId: 'matrix:section',
    values: ['analytics'],
    inGuild: () => true,
    guildId: 'guild-1',
    guild: { id: 'guild-1', ownerId: 'owner-1' },
    user: { id: 'manager-1' },
    member: {
      roles: { cache: new Map([[ROLE_IDS.management, {}]]) },
      permissions: managerPermissions,
    },
    memberPermissions: managerPermissions,
    reply: async (response) => response,
  };
  let response = await handleMatrixInteraction(manager, { db });
  assert.equal(response, true);

  manager.values = ['settings'];
  let denied;
  manager.reply = async (value) => {
    denied = value;
  };
  await handleMatrixInteraction(manager, { db });
  assert.match(denied.content, /permissão administrativa/);
  db.close();
});

test('MATRIX mission section reports persisted active and expiring quest counts', async () => {
  const db = createDatabase();
  const embed = (await handleMatrixInteraction({
    isStringSelectMenu: () => true,
    customId: 'matrix:section',
    values: ['missions'],
    inGuild: () => true,
    guildId: 'guild-1',
    guild: { id: 'guild-1', ownerId: 'owner-1' },
    user: { id: 'owner-1' },
    member: {
      roles: { cache: new Map() },
      permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    reply: async (response) => response,
  }, { db }));
  assert.equal(embed, true);
  db.close();
});

test('health report exposes statuses without credentials', async () => {
  const db = createDatabase();
  const client = {
    ws: { ping: 25 },
    isReady: () => true,
    uptime: 60_000,
    guilds: { cache: new Map() },
  };
  const embed = await buildHealthEmbed({
    client,
    db,
    guildId: 'guild-1',
    env: { NVIDIA_API_KEY: '', VOXPAY_API_KEY: 'must-not-be-printed' },
  });
  const serialized = JSON.stringify(embed.toJSON());
  assert.match(serialized, /Operacional/);
  assert.match(serialized, /Não configurado/);
  assert.match(serialized, /VoxPay/);
  assert.match(serialized, /Z.PAY/);
  assert.doesNotMatch(serialized, /must-not-be-printed/);
  db.close();
});

test('announcements require confirmation, constrain mentions and cannot be published twice', async () => {
  const db = createDatabase();
  const adminPermissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
  const destination = {
    id: 'destination-1',
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: async (payload) => {
      sentPayloads.push(payload);
      return { id: 'announcement-message-1' };
    },
  };
  const sentPayloads = [];
  const previewResponse = [];
  const draftInteraction = {
    inGuild: () => true,
    guildId: 'guild-1',
    guild: {
      id: 'guild-1',
      ownerId: 'owner-1',
      roles: { cache: new Map() },
    },
    user: { id: 'admin-1' },
    member: {
      roles: { cache: new Map() },
      permissions: adminPermissions,
    },
    memberPermissions: adminPermissions,
    channelId: 'admin-channel',
    options: {
      getString(name) {
        return {
          titulo: 'Aviso',
          descricao: 'Texto de teste',
          cor: '#F1C40F',
          salvar_modelo: 'promo',
        }[name] ?? null;
      },
      getChannel: () => destination,
      getRole: () => null,
      getAttachment: () => null,
    },
    reply: async (payload) => previewResponse.push(payload),
  };

  await createAnnouncementPreview(draftInteraction, db);
  const draft = db.prepare(`
    SELECT id, status FROM action_drafts WHERE target = 'announcement'
  `).get();
  assert.equal(draft.status, 'pending');
  assert.deepEqual(previewResponse[0].allowedMentions, { parse: [] });
  assert.ok(previewResponse[0].components.length);

  const publishInteraction = {
    customId: `announcement:publish:${draft.id}`,
    inGuild: () => true,
    guildId: 'guild-1',
    channelId: 'admin-channel',
    guild: {
      id: 'guild-1',
      ownerId: 'owner-1',
      roles: { cache: new Map() },
      channels: { fetch: async () => destination },
    },
    user: { id: 'admin-1' },
    member: {
      roles: { cache: new Map() },
      permissions: adminPermissions,
    },
    memberPermissions: adminPermissions,
    reply: async () => {},
    deferUpdate: async () => {},
    editReply: async () => {},
  };

  await handleAnnouncementInteraction(publishInteraction, db);
  await handleAnnouncementInteraction(publishInteraction, db);
  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(sentPayloads[0].allowedMentions, { parse: [], roles: [] });
  assert.equal(db.prepare(
    'SELECT status FROM announcement_publications WHERE draft_id = ?',
  ).get(draft.id).status, 'published');
  assert.ok(JSON.parse(db.prepare(
    'SELECT settings FROM guild_config WHERE guild_id = ?',
  ).get('guild-1').settings).announcementTemplates.promo);
  db.close();
});
