import { Events, MessageFlags } from 'discord.js';
import {
  handleComponentInteraction,
  handleModalSubmit,
} from './componentCreate.js';

export function registerInteractionCreateEvent(client, commands, services) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (command) {
          await command.execute(interaction, services);
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction, services);
        return;
      }

      if (interaction.isMessageComponent()) {
        await handleComponentInteraction(interaction, services);
      }
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const operation = interaction.isChatInputCommand()
        ? `/${interaction.commandName}`
        : 'interação';
      console.error(`Falha ao executar ${operation} (${errorName}).`);

      try {
        const response = {
          content: 'Não foi possível executar este comando. Tente novamente.',
          flags: MessageFlags.Ephemeral,
        };

        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(response);
        } else {
          await interaction.reply(response);
        }
      } catch (responseError) {
        const responseErrorName = responseError instanceof Error
          ? responseError.name
          : 'UnknownError';
        console.error(`Falha ao informar o erro da interação (${responseErrorName}).`);
      }
    }
  });
}
