import { Events } from 'discord.js';
import { respondToMessage } from '../services/ai.js';
import {
  getSessionForMessage,
  hasSessionAccess,
  storeMessageImages,
} from '../services/customization.js';

const prefixAliases = ['!vanta', '!yelow', '!vinter'];
const prefixCommands = new Set([
  'ping',
  'healty',
  'conversa',
  'missoes',
  'config',
  'anuncio',
  'comprar',
  'carrinho',
  'personalizar',
  'ajuda',
]);

function parseNamedArguments(text) {
  const values = new Map();
  const expression = /([a-z][a-z0-9_]*)=(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+))/gi;

  for (const match of text.matchAll(expression)) {
    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    values.set(match[1].toLowerCase(), rawValue.replace(/\\(["'])/g, '$1'));
  }
  return values;
}

function parseCommandText(content, client, mentionedBot) {
  let text = content;
  for (const alias of prefixAliases) {
    if (text.toLowerCase().startsWith(`${alias} `) || text.toLowerCase() === alias) {
      text = text.slice(alias.length).trim();
      break;
    }
  }

  if (mentionedBot) {
    text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  } else if (text === content) {
    return null;
  }

  const [rawName, ...remaining] = text.split(/\s+/).filter(Boolean);
  const name = rawName?.replace(/^\//, '').toLowerCase();
  if (!name || !prefixCommands.has(name)) {
    return null;
  }

  const subcommand = remaining[0]?.toLowerCase() ?? null;
  const argumentsText = remaining.slice(subcommand ? 1 : 0).join(' ');
  return { name, subcommand, values: parseNamedArguments(argumentsText) };
}

function createMessageInteraction(message, parsed) {
  let replied = false;
  let deferred = false;
  let privateReply = false;

  const send = async (payload = {}) => {
    const hasInteractiveComponents = Array.isArray(payload.components)
      && payload.components.length > 0;
    const keepComponentsInGuild = hasInteractiveComponents
      && ['anuncio', 'comprar'].includes(parsed.name);
    if ((privateReply || payload.ephemeral) && !keepComponentsInGuild) {
      privateReply = true;
      const { ephemeral, ...privatePayload } = payload;
      return message.author.send(privatePayload);
    }
    const { ephemeral, ...channelPayload } = payload;
    return message.channel.send(channelPayload);
  };

  return {
    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guildId,
    channelId: message.channelId,
    channel: message.channel,
    client: message.client,
    createdTimestamp: message.createdTimestamp,
    memberPermissions: message.memberPermissions,
    replied,
    deferred,
    inGuild: () => Boolean(message.guildId),
    options: {
      getSubcommand: () => parsed.subcommand,
      getString: (name) => parsed.values.get(name) ?? null,
      getBoolean: (name) => {
        const value = parsed.values.get(name);
        return value === 'true' ? true : value === 'false' ? false : null;
      },
      getChannel: (name) => {
        const id = parsed.values.get(name);
        return id ? message.guild.channels.cache.get(id) ?? null : null;
      },
      getRole: (name) => {
        const id = parsed.values.get(name);
        return id ? message.guild.roles.cache.get(id) ?? null : null;
      },
      getAttachment: () => message.attachments?.first() ?? null,
    },
    async reply(payload) {
      const response = await send(payload);
      replied = true;
      this.replied = true;
      return response;
    },
    async deferReply(options = {}) {
      privateReply = options.ephemeral === true;
      deferred = true;
      this.deferred = true;
      await message.channel.sendTyping();
    },
    async editReply(payload) {
      const response = await send(payload);
      replied = true;
      this.replied = true;
      this.deferred = false;
      deferred = false;
      return response;
    },
    async followUp(payload) {
      return send(payload);
    },
  };
}

async function dispatchMessageCommand(message, commandMap, services, parsed) {
  if (parsed.name === 'ajuda') {
    await message.reply([
      '**Prefixos VANTA:** `!vanta` e `!yelow`',
      '`ping`, `healty`, `conversa limpar`, `missoes listar`, `missoes cadastrar`, `comprar`, `personalizar`, `anuncio preparar`',
      'Para comandos com várias opções, use `chave="valor"`; respostas privadas chegam por DM.',
      'O Config Center privado é `/config center`; menções com texto livre conversam com a IA.',
    ].join('\n'));
    return true;
  }

  if (parsed.name === 'config') {
    await message.reply('O Config Center é interativo e privado. Use `/config center`.');
    return true;
  }

  if (!['ping', 'healty', 'conversa', 'missoes', 'anuncio', 'comprar', 'personalizar']
    .includes(parsed.name)) {
    await message.reply(`Use o comando slash \`/${parsed.name}\`; esta função precisa de uma interação segura do Discord.`);
    return true;
  }

  const command = commandMap.get(parsed.name);
  if (!command) {
    return false;
  }

  const interaction = createMessageInteraction(message, parsed);
  await command.execute(interaction, services);
  return true;
}

export function registerMessageCreateEvent(client, services, commandMap) {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }

    const mentionedBot = message.mentions.has(client.user);
    const parsedCommand = parseCommandText(message.content.trim(), client, mentionedBot);
    if (parsedCommand) {
      try {
        const dispatched = await dispatchMessageCommand(message, commandMap, services, parsedCommand);
        if (!dispatched) {
          await message.reply('Comando não disponível por prefixo. Consulte os comandos slash.');
        }
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        console.error(`Falha ao executar comando por mensagem (${errorName}).`);
        await message.reply(
          'Não foi possível concluir o comando. Se a resposta privada estiver bloqueada, habilite suas DMs ou use o comando slash.',
        ).catch((replyError) => {
          const replyErrorName = replyError instanceof Error ? replyError.name : 'UnknownError';
          console.error(`Falha ao informar erro de comando (${replyErrorName}).`);
        });
      }
      return;
    }

    const session = getSessionForMessage(
      services.db,
      message.guildId,
      message.channelId,
    );

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

      if (savedImages.length && !text) {
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
        error?.name === 'AiServiceError'
          ? error.message
          : 'Não foi possível concluir a solicitação. Tente novamente ou procure a equipe.',
      ).catch((replyError) => {
        const replyErrorName = replyError instanceof Error ? replyError.name : 'UnknownError';
        console.error(`Falha ao informar erro de mensagem (${replyErrorName}).`);
      });
    }
  });
}
