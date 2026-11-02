import { SlashCommandBuilder } from 'discord.js';
import { isStaff } from '../services/permissions.js';
import { buildHealthEmbed } from '../services/matrix.js';

export const healtyCommand = {
  data: new SlashCommandBuilder()
    .setName('healty')
    .setDescription('Exibe o diagnóstico operacional do bot.'),

  async execute(interaction, { db }) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use este comando em um servidor.',
        ephemeral: true,
      });
      return;
    }

    if (!isStaff(interaction, db)) {
      await interaction.reply({
        content: 'Somente a equipe autorizada pode consultar o diagnóstico.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const embed = await buildHealthEmbed({
      client: interaction.client,
      db,
      guildId: interaction.guildId,
    });
    await interaction.editReply({ embeds: [embed] });
  },
};
