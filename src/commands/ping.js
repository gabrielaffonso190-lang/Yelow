import { MessageFlags, SlashCommandBuilder } from 'discord.js';

export const pingCommand = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Verifica se a VANTA está respondendo.'),

  async execute(interaction) {
    const roundTripMs = Date.now() - interaction.createdTimestamp;
    const gatewayMs = Math.round(interaction.client.ws.ping);

    await interaction.reply({
      content: `Pong! Latência: ${roundTripMs} ms; gateway: ${gatewayMs} ms.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
