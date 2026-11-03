import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const requiredTables = [
  'action_drafts',
  'audit_logs',
  'cart_items',
  'carts',
  'conversations',
  'coupon_uses',
  'coupons',
  'customization_sessions',
  'guild_config',
  'image_assets',
  'inventory_reservations',
  'order_items',
  'orders',
  'products',
  'support_tickets',
  'tickets',
];

function createBaseSchema(db) {
  db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Geral',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
      image_asset_id TEXT,
      stock INTEGER CHECK (stock IS NULL OR stock >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE (guild_id, name)
    );
    CREATE TABLE carts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      coupon_code TEXT,
      checkout_order_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE cart_items (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      PRIMARY KEY (guild_id, user_id, product_id),
      FOREIGN KEY (guild_id, user_id) REFERENCES carts(guild_id, user_id)
        ON DELETE CASCADE
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_service', 'cancelled')),
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
      discount_cents INTEGER NOT NULL CHECK (discount_cents >= 0),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      coupon_code TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE order_items (
      order_id TEXT NOT NULL REFERENCES orders(id),
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      PRIMARY KEY (order_id, product_id)
    );
    CREATE TABLE tickets (
      order_id TEXT PRIMARY KEY REFERENCES orders(id),
      guild_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closed')),
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closed')),
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE coupons (
      id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      code TEXT NOT NULL,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
      discount_value INTEGER NOT NULL CHECK (discount_value > 0),
      valid_from TEXT,
      valid_until TEXT,
      max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
      min_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_cents >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_by TEXT NOT NULL,
      PRIMARY KEY (guild_id, code)
    );
    CREATE TABLE coupon_uses (
      guild_id TEXT NOT NULL,
      coupon_id TEXT NOT NULL,
      coupon_code TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, coupon_id, order_id)
    );
    CREATE TABLE inventory_reservations (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
      PRIMARY KEY (order_id, product_id)
    );
    CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY,
      settings TEXT NOT NULL DEFAULT '{}',
      staff_role_ids TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY,
      guild_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE customization_sessions (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'closed')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES customization_sessions(id),
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      messages TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id, user_id)
    );
    CREATE TABLE action_drafts (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      target TEXT NOT NULL,
      value TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function openDatabase(path = process.env.DATABASE_PATH || 'data/vintermod.sqlite') {
  const resolvedPath = resolve(path);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  let tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map(({ name }) => name));
  if (!tables.size) {
    createBaseSchema(db);
    tables = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map(({ name }) => name));
  }
  const missingTables = requiredTables.filter((table) => !tables.has(table));

  if (missingTables.length > 0) {
    db.close();
    throw new Error(`Database schema is incomplete; missing tables: ${missingTables.join(', ')}`);
  }

  const productColumns = new Set(db.prepare('PRAGMA table_info(products)')
    .all().map(({ name }) => name));

  if (!productColumns.has('cost_cents')) {
    db.exec(`
      ALTER TABLE products
      ADD COLUMN cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0)
    `);
  }

  if (!productColumns.has('image_asset_id')) {
    db.exec('ALTER TABLE products ADD COLUMN image_asset_id TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS announcement_publications (
      draft_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('publishing', 'published', 'failed')),
      created_at TEXT NOT NULL
    )
  `);
  ensureMissionSchema(db);
  ensurePaymentSchema(db);

  return db;
}

export function ensureMissionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      promoted_content TEXT NOT NULL,
      quest_type TEXT NOT NULL CHECK (quest_type IN ('play', 'video')),
      requirements TEXT NOT NULL,
      reward TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      platforms TEXT NOT NULL,
      official_url TEXT,
      instructions TEXT,
      banner_url TEXT,
      source_url TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'unavailable')),
      alert_sent_at TEXT,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      announcement_channel_id TEXT,
      announced_message_id TEXT,
      announcement_status TEXT NOT NULL DEFAULT 'none'
        CHECK (announcement_status IN ('none', 'publishing', 'published')),
      CHECK (official_url IS NOT NULL OR instructions IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_missions_guild_status_ends
      ON missions(guild_id, status, ends_at);
    CREATE INDEX IF NOT EXISTS idx_missions_reminders
      ON missions(status, ends_at, alert_sent_at);
  `);
  const missionColumns = new Set(db.prepare('PRAGMA table_info(missions)')
    .all().map(({ name }) => name));
  if (!missionColumns.has('announcement_status')) {
    db.exec(`
      ALTER TABLE missions ADD COLUMN announcement_status TEXT NOT NULL DEFAULT 'none'
        CHECK (announcement_status IN ('none', 'publishing', 'published'))
    `);
  }
  const additiveColumns = [
    ['source_name', 'TEXT'],
    ['source_published_at', 'TEXT'],
    ['image_source', 'TEXT'],
    ['image_source_url', 'TEXT'],
    ['image_identifier', 'TEXT'],
    ['campaign_fingerprint', 'TEXT'],
    ['announcement_updated_at', 'TEXT'],
  ];
  for (const [column, type] of additiveColumns) {
    if (!missionColumns.has(column)) {
        db.exec(`ALTER TABLE missions ADD COLUMN ${column} ${type}`);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_guild_fingerprint
        ON missions(guild_id, campaign_fingerprint)
        WHERE campaign_fingerprint IS NOT NULL;
    CREATE TABLE IF NOT EXISTS mission_discovery_sources (
        source_key TEXT PRIMARY KEY,
        source_name TEXT NOT NULL,
        source_url TEXT,
        access_mode TEXT NOT NULL CHECK (access_mode IN ('automatic', 'manual')),
        status TEXT NOT NULL DEFAULT 'pending',
        last_checked_at TEXT,
        next_check_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        entries_found INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mission_discovery_entries (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL REFERENCES mission_discovery_sources(source_key),
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        image_url TEXT,
        status TEXT NOT NULL DEFAULT 'review'
          CHECK (status IN ('review', 'imported', 'ignored')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (source_key, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mission_discovery_review
        ON mission_discovery_entries(status, first_seen_at DESC);
    CREATE TABLE IF NOT EXISTS mission_discovery_entry_history (
        id INTEGER PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES mission_discovery_entries(id),
        previous_title TEXT NOT NULL,
        previous_summary TEXT NOT NULL,
        next_title TEXT NOT NULL,
        next_summary TEXT NOT NULL,
        changed_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO mission_discovery_sources (
        source_key, source_name, source_url, access_mode, status, last_error
    ) VALUES
        ('discord_discover_quests', 'Discord Discover → Quests', NULL, 'manual', 'manual',
          'Consulta automatizada indisponível: não há API pública documentada de Quests.'),
        ('discord_blog', 'Discord Blog (RSS oficial)', 'https://discord.com/blog/rss.xml',
          'automatic', 'pending', NULL),
        ('discord_newsroom', 'Discord Newsroom', 'https://discord.com/newsroom',
          'manual', 'manual',
          'Página pública sem feed estruturado estável confirmado para campanhas de Quests.');
  `);
}

export function ensurePaymentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      provider TEXT NOT NULL CHECK (provider IN ('zpay', 'voxpay')),
      provider_payment_id TEXT,
      idempotency_key TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      environment TEXT NOT NULL DEFAULT 'production'
        CHECK (environment IN ('production', 'sandbox')),
      status TEXT NOT NULL CHECK (status IN (
        'creating', 'pending', 'paid', 'expired', 'failed', 'cancelled',
        'refunded', 'outcome_unknown'
      )),
      copy_paste TEXT,
      qr_code_data_url TEXT,
      expires_at TEXT,
      payment_method TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT,
      UNIQUE (order_id, provider),
      UNIQUE (provider, idempotency_key),
      UNIQUE (provider, provider_payment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_payments_order_status
      ON payments(order_id, status);
    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      event_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      payment_id TEXT REFERENCES payments(id),
      external_payment_id TEXT,
      amount_cents INTEGER,
      paid_at TEXT,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  const paymentColumns = new Set(db.prepare('PRAGMA table_info(payments)')
    .all().map(({ name }) => name));
  if (!paymentColumns.has('last_error_code')) {
    db.exec('ALTER TABLE payments ADD COLUMN last_error_code TEXT');
  }
  if (!paymentColumns.has('last_http_status')) {
    db.exec('ALTER TABLE payments ADD COLUMN last_http_status INTEGER');
  }
  if (!paymentColumns.has('provider_fee_cents')) {
    db.exec('ALTER TABLE payments ADD COLUMN provider_fee_cents INTEGER');
  }
  if (!paymentColumns.has('environment')) {
    db.exec(`
      ALTER TABLE payments ADD COLUMN environment TEXT NOT NULL DEFAULT 'production'
        CHECK (environment IN ('production', 'sandbox'))
    `);
  }
  const webhookColumns = new Set(db.prepare('PRAGMA table_info(payment_webhook_events)')
    .all().map(({ name }) => name));
  if (!webhookColumns.has('external_payment_id')) {
    db.exec('ALTER TABLE payment_webhook_events ADD COLUMN external_payment_id TEXT');
  }
  if (!webhookColumns.has('amount_cents')) {
    db.exec('ALTER TABLE payment_webhook_events ADD COLUMN amount_cents INTEGER');
  }
  if (!webhookColumns.has('paid_at')) {
    db.exec('ALTER TABLE payment_webhook_events ADD COLUMN paid_at TEXT');
  }
  if (!webhookColumns.has('delivery_id')) {
    db.exec('ALTER TABLE payment_webhook_events ADD COLUMN delivery_id TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_webhook_delivery
    ON payment_webhook_events(provider, delivery_id)
    WHERE delivery_id IS NOT NULL
  `);
}

export function withTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getGuildSettings(db, guildId) {
  const row = db.prepare('SELECT settings, staff_role_ids FROM guild_config WHERE guild_id = ?')
    .get(guildId);

  if (!row) {
    return { settings: {}, staffRoleIds: [] };
  }

  return {
    settings: JSON.parse(row.settings),
    staffRoleIds: JSON.parse(row.staff_role_ids),
  };
}

export function updateGuildSettings(db, guildId, updates) {
  const current = getGuildSettings(db, guildId);
  const settings = { ...current.settings, ...updates };

  db.prepare(`
    INSERT INTO guild_config (guild_id, settings, staff_role_ids, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      settings = excluded.settings,
      updated_at = excluded.updated_at
  `).run(guildId, JSON.stringify(settings), JSON.stringify(current.staffRoleIds), new Date().toISOString());

  return settings;
}

export function updateStaffRoles(db, guildId, roleIds) {
  const current = getGuildSettings(db, guildId);

  db.prepare(`
    INSERT INTO guild_config (guild_id, settings, staff_role_ids, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      staff_role_ids = excluded.staff_role_ids,
      updated_at = excluded.updated_at
  `).run(
    guildId,
    JSON.stringify(current.settings),
    JSON.stringify([...new Set(roleIds)]),
    new Date().toISOString(),
  );
}

export function writeAuditLog(db, guildId, actorId, action, details = {}) {
  db.prepare(`
    INSERT INTO audit_logs (guild_id, actor_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, actorId, action, JSON.stringify(details), new Date().toISOString());
}
