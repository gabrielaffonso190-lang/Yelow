import { pingCommand } from './ping.js';
import { missionsCommand } from './missions.js';
import { healtyCommand } from './healty.js';
import { announcementCommand } from './announcement.js';
import { configCommand } from './config.js';
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
];
