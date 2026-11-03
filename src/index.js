import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands } from './commands/index.js';
import { getDiscordConfig } from './config/env.js';
import { registerInteractionCreateEvent } from './events/interactionCreate.js';
import { registerMessageCreateEvent } from './events/messageCreate.js';
import { registerReadyEvent } from './events/ready.js';
import { openDatabase } from './services/db.js';
import { recoverCustomizationSessions } from './services/customization.js';
import { clearConversation } from './services/ai.js';
import { recoverMatrixPanel } from './services/matrix.js';
import { createPaymentProviders } from './services/paymentProviders.js';
import { startPaymentWebhookServer } from './services/payments.js';
import { startMissionMaintenance } from './services/missions.js';
import { startMissionDiscovery } from './services/missionDiscovery.js';

async function main() {
  const { token } = getDiscordConfig();
  const db = openDatabase();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const commandMap = new Map(commands.map((command) => [command.data.name, command]));
  const paymentConfiguration = createPaymentProviders();
  const services = {
    db,
    ai: { clearConversation },
    payments: paymentConfiguration,
  };

  registerReadyEvent(client);
  registerInteractionCreateEvent(client, commandMap, services);
  registerMessageCreateEvent(client, services, commandMap);
  client.on(Events.Error, (error) => {
    console.error(`Erro no cliente Discord (${error.name}).`);
  });

  client.once(Events.ClientReady, () => {
    try {
      const port = Number(process.env.ZPAY_WEBHOOK_PORT || 8787);
      const server = startPaymentWebhookServer({
        db,
        secret: process.env.ZPAY_WEBHOOK_SECRET?.trim(),
        voxpaySecret: process.env.VOXPAY_WEBHOOK_SECRET?.trim(),
        port,
      });
      if (server) {
        server.on('error', (error) => {
          console.error(`Falha no servidor webhook Z.PAY (${error.name || 'UnknownError'}).`);
        });
      }
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`Falha ao iniciar webhook Z.PAY (${errorName}).`);
    }

    startMissionMaintenance({ client, db });
    startMissionDiscovery({ client, db });
    recoverCustomizationSessions({ db, client }).catch((error) => {
      console.error(`Falha ao recuperar sessões (${error.name || 'UnknownError'}).`);
    });
    recoverMatrixPanel({ db, client }).catch((error) => {
      console.error(`Falha ao recuperar painel MATRIX (${error.name || 'UnknownError'}).`);
    });
  });

  await client.login(token);
}

main().catch((error) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(`Não foi possível iniciar a VANTA (${errorName}).`);
  process.exitCode = 1;
});
