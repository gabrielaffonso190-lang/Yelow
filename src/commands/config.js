import { SlashCommandBuilder } from 'discord.js';
import { isAdmin } from '../services/permissions.js';
import { configurationPanel } from '../services/ui.js';
import { ensureDefaultCatalog } from '../services/commerce.js';

export const configCommand = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configura a VANTA neste servidor.')
    .addSubcommand((subcommand) => subcommand
      .setName('center')
      .setDescription('Abre o painel de configuração do servidor.')),

  async execute(interaction, services) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Use este comando em um servidor.', ephemeral: true });
      return;
    }

    if (!isAdmin(interaction, services.db)) {
      await interaction.reply({
        content: 'Somente administradores autorizados podem abrir o Config Center.',
        ephemeral: true,
      });
      return;
    }

    ensureDefaultCatalog(services.db, interaction.guildId);
    await interaction.reply({ ...configurationPanel(services.db, interaction.guildId), ephemeral: true });
  },
};
