import { PermissionFlagsBits } from 'discord.js';
import { getGuildSettings } from './db.js';

export const ROLE_IDS = Object.freeze({
  management: '1560463269033017414',
  direction: '1560463263949398057',
  generalPower: '1560463227631177889',
  founder: '1560463223055187968',
});

const adminRoleIds = [ROLE_IDS.generalPower, ROLE_IDS.founder];
const operationalRoleIds = [ROLE_IDS.management, ROLE_IDS.direction];

function getMemberRoleIds(member) {
  const memberRoles = member?.roles;
  return Array.isArray(memberRoles)
    ? memberRoles
    : memberRoles?.cache
      ? [...memberRoles.cache.keys()]
      : [];
}

function hasPermissions(member, flags) {
  const permissions = member?.permissions;
  return flags.some((flag) => permissions?.has(flag));
}

function isGuildOwnerOrAdmin({ guild, member, userId }) {
  return userId === guild.ownerId
    || hasPermissions(member, [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
    ]);
}

export function isAdmin(interaction, db) {
  if (!interaction.inGuild()) {
    return false;
  }

  const isOwner = interaction.user.id === interaction.guild.ownerId;
  const hasAdminPermission = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
  ].some((flag) => interaction.memberPermissions?.has(flag)
    || interaction.member?.permissions?.has(flag));
  if (isOwner || hasAdminPermission) {
    return true;
  }

  const roleIds = getMemberRoleIds(interaction.member);
  return adminRoleIds.some((roleId) => roleIds.includes(roleId));
}

export function hasStaffRole(member, staffRoleIds) {
  const roles = getMemberRoleIds(member);
  return staffRoleIds.some((roleId) => roles.includes(roleId));
}

export function isGuildAdmin({ guild, member, userId }, db) {
  if (!guild || !userId) {
    return false;
  }

  if (isGuildOwnerOrAdmin({ guild, member, userId })) {
    return true;
  }

  return adminRoleIds.some((roleId) => getMemberRoleIds(member).includes(roleId));
}

export function isGuildStaff({ guild, member, userId }, db) {
  if (isGuildAdmin({ guild, member, userId }, db)) {
    return true;
  }

  if (!guild || !userId) {
    return false;
  }

  const { settings, staffRoleIds } = getGuildSettings(db, guild.id);
  const supportRoleIds = Array.isArray(settings.supportRoleIds)
    ? settings.supportRoleIds
    : [];
  return hasStaffRole(member, [
    ...operationalRoleIds,
    ...staffRoleIds,
    ...supportRoleIds,
  ]);
}

export function isStaff(interaction, db) {
  if (!interaction.inGuild()) {
    return false;
  }

  if (isAdmin(interaction, db)) {
    return true;
  }

  return isGuildStaff({
    guild: interaction.guild,
    member: interaction.member,
    userId: interaction.user.id,
  }, db);
}

export function getOperationalRoleIds(db, guildId, guild) {
  const { settings, staffRoleIds } = getGuildSettings(db, guildId);
  const supportRoleIds = Array.isArray(settings.supportRoleIds)
    ? settings.supportRoleIds
    : [];
  return [...new Set([
    ...adminRoleIds,
    ...operationalRoleIds,
    ...staffRoleIds,
    ...supportRoleIds,
  ])].filter((roleId) => guild?.roles?.cache?.has(roleId));
}
