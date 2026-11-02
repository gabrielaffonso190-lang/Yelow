import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import {
  createCustomizationSession,
  hasSessionAccess,
  recoverCustomizationSessions,
} from '../src/services/customization.js';
import { getGuildSettings, updateGuildSettings, updateStaffRoles } from '../src/services/db.js';
import {
  isAdmin,
  isGuildStaff,
  isStaff,
  ROLE_IDS,
} from '../src/services/permissions.js';

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}',
      staff_role_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE customization_sessions (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'closed')),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  return db;
}

test('guild settings and staff role permissions are isolated per server', () => {
  const db = createDatabase();
  updateGuildSettings(db, 'guild-1', { shopMessage: 'Olá' });
  updateGuildSettings(db, 'guild-2', { shopMessage: 'Outro servidor' });
  updateStaffRoles(db, 'guild-1', ['role-staff']);
  const guild = { id: 'guild-1', ownerId: 'owner-1' };
  const staffMember = {
    id: 'staff-1',
    roles: { cache: new Map([['role-staff', {}]]) },
    permissions: new PermissionsBitField(),
  };
  const plainMember = {
    id: 'user-1',
    roles: { cache: new Map() },
    permissions: new PermissionsBitField(),
  };

  assert.deepEqual(getGuildSettings(db, 'guild-2'), {
    settings: { shopMessage: 'Outro servidor' },
    staffRoleIds: [],
  });
  assert.equal(isGuildStaff({
    guild,
    member: staffMember,
    userId: staffMember.id,
  }, db), true);
  assert.equal(isGuildStaff({
    guild,
    member: plainMember,
    userId: plainMember.id,
  }, db), false);
  assert.equal(isGuildStaff({
    guild,
    member: plainMember,
    userId: guild.ownerId,
  }, db), true);
  assert.equal(isStaff({
    inGuild: () => true,
    guild,
    guildId: guild.id,
    user: plainMember,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    member: plainMember,
  }, db), true);
  db.close();
});

test('administrative hierarchy separates operational roles from administrators', () => {
  const db = createDatabase();
  const guild = { id: 'guild-1', ownerId: 'owner-1' };
  const makeInteraction = (roleId) => {
    const member = {
      id: 'member-1',
      roles: { cache: new Map([[roleId, {}]]) },
      permissions: new PermissionsBitField(),
    };
    return {
      inGuild: () => true,
      guild,
      guildId: guild.id,
      user: { id: member.id },
      member,
      memberPermissions: member.permissions,
    };
  };

  const manager = makeInteraction(ROLE_IDS.management);
  const direction = makeInteraction(ROLE_IDS.direction);
  const generalPower = makeInteraction(ROLE_IDS.generalPower);
  const founder = makeInteraction(ROLE_IDS.founder);

  assert.equal(isStaff(manager, db), true);
  assert.equal(isAdmin(manager, db), false);
  assert.equal(isStaff(direction, db), true);
  assert.equal(isAdmin(direction, db), false);
  assert.equal(isAdmin(generalPower, db), true);
  assert.equal(isAdmin(founder, db), true);
  db.close();
});

test('customization sessions expire after 15 minutes, block duplicates and recover after restart', async () => {
  const db = createDatabase();
  let created = 0;
  const sentMessages = [];
  const permissionEdits = [];
  const channel = {
    id: 'channel-1',
    send: async (message) => sentMessages.push(message),
    delete: async () => {},
    permissionOverwrites: {
      edit: async (userId, permissions) => permissionEdits.push({ userId, permissions }),
    },
  };
  const client = {
    channels: { fetch: async () => channel },
  };
  const guild = {
    id: 'guild-1',
    client,
    roles: {
      everyone: { id: 'guild-1' },
      cache: { has: () => false },
    },
    channels: {
      create: async () => {
        created += 1;
        return channel;
      },
      fetch: async () => channel,
    },
  };
  const user = { id: 'user-1' };
  const first = await createCustomizationSession({
    db,
    guild,
    user,
    clientUserId: 'bot-1',
  });
  const duplicate = await createCustomizationSession({
    db,
    guild,
    user,
    clientUserId: 'bot-1',
  });

  assert.equal(first.id, duplicate.id);
  assert.equal(created, 1);
  const session = db.prepare(
    'SELECT * FROM customization_sessions WHERE user_id = ?',
  ).get(user.id);
  const remaining = Date.parse(session.expires_at) - Date.now();
  assert.ok(remaining > 14 * 60 * 1000 && remaining <= 15 * 60 * 1000);
  assert.equal(hasSessionAccess(db, session, { id: user.id, roles: { cache: new Map() } }), true);

  db.prepare('UPDATE customization_sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), session.id);
  await recoverCustomizationSessions({ db, client });

  assert.equal(db.prepare(
    'SELECT status FROM customization_sessions WHERE id = ?',
  ).get(session.id).status, 'closed');
  assert.equal(permissionEdits[0].userId, user.id);
  assert.match(sentMessages.at(-1), /15 minutos/);
  db.close();
});
