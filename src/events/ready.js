import { Events } from 'discord.js';
import { loadApplicationEmojis } from '../config/emojis.js';

export function registerReadyEvent(client) {
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`VANTA conectada como ${readyClient.user.tag}.`);
    try {
      const loaded = await loadApplicationEmojis(readyClient);
      console.log(`Emojis oficiais da aplicação carregados: ${loaded}.`);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`Não foi possível carregar emojis da aplicação (${errorName}).`);
    }
  });
}
