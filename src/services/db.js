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

export function openDatabase(path = process.env.DATABASE_PATH || 'data/vintermod.sqlite') {
  const resolvedPath = resolve(path);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map(({ name }) => name));
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
  ensurePaymentSchema(db);

  return db;
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
