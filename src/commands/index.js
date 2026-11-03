import { pingCommand } from './ping.js';
import { missionsCommand } from './missions.js';
import { healtyCommand } from './healty.js';
import { announcementCommand } from './announcement.js';
import { configCommand } from './config.js';
import { generateCommand, orderCommand, stockCommand } from './operations.js';
import {
  cartCommand,
  conversationCommand,
  customizeCommand,
  shopCommand,
} from './commerce.js';

export const commands = [
  pingCommand,
  healtyCommand,
  announcementCommand,
  configCommand,
  shopCommand,
  cartCommand,
  customizeCommand,
  conversationCommand,
  missionsCommand,
  generateCommand,
  orderCommand,
  stockCommand,
];

export function getSlashCommandPayload(commandList = commands) {
  const names = new Set();
  const payload = commandList.map((command) => {
    const data = command.data?.toJSON?.();
    const name = data?.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('Every slash command must define a valid name.');
    }
    if (names.has(name)) {
      throw new Error(`Duplicate slash command name: ${name}`);
    }
    names.add(name);
    return data;
  });
  return payload;
}

export function createCommandMap(commandList = commands) {
  getSlashCommandPayload(commandList);
  return new Map(commandList.map((command) => [command.data.name, command]));
}
