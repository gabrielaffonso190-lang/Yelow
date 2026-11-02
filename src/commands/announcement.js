import { ChannelType, SlashCommandBuilder } from 'discord.js';
import {
  AnnouncementError,
  createAnnouncementPreview,
} from '../services/announcements.js';

export const announcementCommand = {
  data: new SlashCommandBuilder()
    .setName('anuncio')
    .setDescription('Prepara e publica anúncios administrativos.')
    .addSubcommand((subcommand) => subcommand
      .setName('preparar')
      .setDescription('Cria uma pré-visualização que exige confirmação.')
      .addStringOption((option) => option
        .setName('titulo')
        .setDescription('Título do anúncio')
        .setMaxLength(256))
      .addStringOption((option) => option
        .setName('descricao')
        .setDescription('Descrição do anúncio')
        .setMaxLength(4000))
      .addChannelOption((option) => option
        .setName('canal')
        .setDescription('Canal de destino')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((option) => option
        .setName('cor')
        .setDescription('Cor hexadecimal no formato #RRGGBB')
        .setMaxLength(7))
      .addStringOption((option) => option
        .setName('rodape')
        .setDescription('Texto de rodapé')
        .setMaxLength(2048))
      .addRoleOption((option) => option
        .setName('mencionar_cargo')
        .setDescription('Cargo permitido para menção explícita'))
      .addAttachmentOption((option) => option
        .setName('imagem')
        .setDescription('Imagem enviada pelo Discord (máximo 8 MB)'))
      .addStringOption((option) => option
        .setName('botao_texto')
        .setDescription('Rótulo opcional do botão')
        .setMaxLength(80))
      .addStringOption((option) => option
        .setName('botao_url')
        .setDescription('Link HTTPS do botão')
        .setMaxLength(512))
      .addStringOption((option) => option
        .setName('modelo')
        .setDescription('Nome de um modelo salvo para reutilizar')
        .setMaxLength(30))
      .addStringOption((option) => option
        .setName('salvar_modelo')
        .setDescription('Salvar ou atualizar um modelo')
        .setMaxLength(30))),

  async execute(interaction, { db }) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use este comando em um servidor.',
        ephemeral: true,
      });
      return;
    }

    try {
      await createAnnouncementPreview(interaction, db);
    } catch (error) {
      if (!(error instanceof AnnouncementError) || interaction.replied || interaction.deferred) {
        throw error;
      }

      await interaction.reply({ content: error.message, ephemeral: true });
    }
  },
};
