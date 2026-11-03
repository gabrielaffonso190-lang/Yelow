import { SlashCommandBuilder } from 'discord.js';
import { createCustomizationSession } from '../services/customization.js';
import { ensureDefaultCatalog } from '../services/commerce.js';
import { buildCartView, buildShopView } from '../services/ui.js';

export const shopCommand = {
  data: new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Consulte o catálogo e escolha produtos.'),

  async execute(interaction, services) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Use este comando em um servidor.', ephemeral: true });
      return;
    }

    ensureDefaultCatalog(services.db, interaction.guildId);
    await interaction.reply({
      ...buildShopView(services.db, interaction.guildId),
    });
  },
};

export const cartCommand = {
  data: new SlashCommandBuilder()
    .setName('carrinho')
    .setDescription('Visualize e gerencie seu carrinho.'),

  async execute(interaction, services) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Use este comando em um servidor.', ephemeral: true });
      return;
    }

    await interaction.reply({
      ...buildCartView(services.db, interaction.guildId, interaction.user.id),
      ephemeral: true,
    });
  },
};

export const customizeCommand = {
  data: new SlashCommandBuilder()
    .setName('personalizar')
    .setDescription('Abre um canal privado de personalização por 15 minutos.'),

  async execute(interaction, services) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Use este comando em um servidor.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const channel = await createCustomizationSession({
      db: services.db,
      guild: interaction.guild,
      user: interaction.user,
      clientUserId: interaction.client.user.id,
    });

    await interaction.editReply(`Canal de personalização: ${channel}`);
  },
};

export const conversationCommand = {
  data: new SlashCommandBuilder()
    .setName('conversa')
    .setDescription('Gerencia seu histórico de conversa com a IA.')
    .addSubcommand((subcommand) => subcommand
      .setName('limpar')
      .setDescription('Apaga seu histórico de conversa neste canal.')),

  async execute(interaction, services) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Use este comando em um servidor.', ephemeral: true });
      return;
    }

    services.ai.clearConversation(
      services.db,
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    await interaction.reply({
      content: 'Seu histórico de conversa neste canal foi apagado.',
      ephemeral: true,
    });
  },
};
