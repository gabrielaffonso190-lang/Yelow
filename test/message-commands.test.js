import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Events } from 'discord.js';
import { registerMessageCreateEvent } from '../src/events/messageCreate.js';

function createMessage(content, mentioned) {
  const sent = [];
  const dm = [];
  const client = { user: { id: 'bot-1' } };
  const message = {
    content,
    author: { id: 'user-1', bot: false, send: async (payload) => dm.push(payload) },
    member: { permissions: { has: () => false }, roles: { cache: new Map() } },
    guild: { id: 'guild-1', channels: { cache: new Map() } },
    guildId: 'guild-1',
    channelId: 'channel-1',
    channel: { send: async (payload) => sent.push(payload), sendTyping: async () => {} },
    client,
    createdTimestamp: Date.now(),
    mentions: { has: () => mentioned },
    reply: async (payload) => sent.push(payload),
  };
  return { client, message, sent, dm };
}

async function dispatch(content, mentioned = false) {
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  const { message, sent, dm } = createMessage(content, mentioned);
  const commandMap = new Map([['ping', {
    async execute(interaction) {
      await interaction.reply({ content: 'Pong!', ephemeral: true });
    },
  }]]);
  registerMessageCreateEvent(client, {}, commandMap);
  const handler = client.listeners(Events.MessageCreate)[0];
  await handler(message);
  return { sent, dm };
}

test('prefix aliases execute supported commands and keep private responses in DMs', async () => {
  const { sent, dm } = await dispatch('!yelow ping');
  assert.equal(sent.length, 0);
  assert.equal(dm[0].content, 'Pong!');
});

test('a direct bot mention can invoke a registered message command', async () => {
  const { sent, dm } = await dispatch('<@bot-1> ping', true);
  assert.equal(sent.length, 0);
  assert.equal(dm[0].content, 'Pong!');
});
