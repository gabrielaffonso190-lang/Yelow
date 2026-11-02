import { Events } from 'discord.js';
import { respondToMessage } from '../services/ai.js';
import {
  getSessionForMessage,
  hasSessionAccess,
  storeMessageImages,
} from '../services/customization.js';

export function registerMessageCreateEvent(client, services) {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }

    if (message.content.trim().toLowerCase() === '!vinter ping') {
      try {
        await message.reply(`Pong! Gateway: ${Math.round(client.ws.ping)} ms.`);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        console.error(`Falha ao responder ao comando !vinter (${errorName}).`);
      }

      return;
    }

    const session = getSessionForMessage(
      services.db,
      message.guildId,
      message.channelId,
    );
    const mentionedBot = message.mentions.has(client.user);

    if (!session && !mentionedBot) {
      return;
    }

    if (session && !hasSessionAccess(services.db, session, message.member, message.guild)) {
      return;
    }

    try {
      const savedImages = session
        ? await storeMessageImages({ db: services.db, message, session })
        : [];
      const text = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();

      if (savedImages.length) {
        await message.reply(
          `Imagem(ns) armazenada(s) de forma privada: ${savedImages.map((image) => `\`${image.id}\``).join(', ')}. A equipe pode selecioná-la no Config Center.`,
        );
      }

      if (!text && savedImages.length) {
        return;
      }

      if (!text) {
        await message.reply('Mencione a VANTA com uma pergunta para iniciar a conversa.');
        return;
      }

      await message.channel.sendTyping();
      const response = await respondToMessage({
        db: services.db,
        guild: message.guild,
        channelId: message.channelId,
        user: message.author,
        member: message.member,
        content: text,
      });

      await message.reply({
        content: response.content,
        ...(response.components?.length ? { components: response.components } : {}),
        allowedMentions: { repliedUser: false, parse: [] },
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`Falha ao processar mensagem para a IA (${errorName}).`);
      await message.reply(
        'Não foi possível concluir a solicitação. Tente novamente ou procure a equipe.',
      ).catch((replyError) => {
        const replyErrorName = replyError instanceof Error ? replyError.name : 'UnknownError';
        console.error(`Falha ao informar erro de mensagem (${replyErrorName}).`);
      });
    }
  });
}
