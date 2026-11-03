import { ChannelType, SlashCommandBuilder } from 'discord.js';
import {
  buildMissionAnnouncementPreview,
  configureMissionAlerts,
  createMission,
  listMissions,
  MissionError,
  publishMission,
  setMissionStatus,
  syncMissionAnnouncementStatus,
  updateMission,
} from '../services/missions.js';
import { isAdmin } from '../services/permissions.js';
import { getGuildSettings } from '../services/db.js';
import {
  checkMissionDiscoverySources,
  getMissionDiscoveryStatus,
} from '../services/missionDiscovery.js';

const questTypeChoices = [
  { name: 'Play Quest', value: 'play' },
  { name: 'Video Quest', value: 'video' },
];

const statusChoices = [
  { name: 'Encerrada', value: 'ended' },
  { name: 'Indisponível', value: 'unavailable' },
];

function addQuestFields(command, required) {
  return command
    .addStringOption((option) => option
      .setName('nome')
      .setDescription('Nome oficial da Quest')
      .setRequired(required)
      .setMaxLength(100))
    .addStringOption((option) => option
      .setName('conteudo')
      .setDescription('Jogo ou conteúdo promovido')
      .setRequired(required)
      .setMaxLength(100))
    .addStringOption((option) => option
      .setName('tipo')
      .setDescription('Tipo de Quest')
      .setRequired(required)
      .addChoices(...questTypeChoices))
    .addStringOption((option) => option
      .setName('requisitos')
      .setDescription('Requisitos completos e oficiais')
      .setRequired(required)
      .setMaxLength(1000))
    .addStringOption((option) => option
      .setName('recompensa')
      .setDescription('Recompensa confirmada na promoção oficial')
      .setRequired(required)
      .setMaxLength(300))
    .addStringOption((option) => option
      .setName('encerramento')
      .setDescription('Data/hora ISO com fuso, ex.: 2026-12-31T23:59-03:00')
      .setRequired(required)
      .setMaxLength(40))
    .addStringOption((option) => option
      .setName('plataformas')
      .setDescription('Plataformas compatíveis')
      .setRequired(required)
      .setMaxLength(200))
    .addStringOption((option) => option
      .setName('fonte')
      .setDescription('URL HTTPS da fonte oficial verificável')
      .setRequired(required)
      .setMaxLength(512))
    .addStringOption((option) => option
      .setName('link_oficial')
      .setDescription('Link HTTPS direto para a Quest, se disponível')
      .setRequired(false)
      .setMaxLength(512))
    .addStringOption((option) => option
      .setName('como_encontrar')
      .setDescription('Instrução para encontrar a Quest no Discord')
      .setRequired(false)
      .setMaxLength(1000))
    .addStringOption((option) => option
      .setName('banner')
      .setDescription('URL HTTPS do banner oficial ou da imagem enviada pela equipe')
      .setRequired(false)
      .setMaxLength(512))
    .addStringOption((option) => option
      .setName('fonte_imagem')
      .setDescription('URL HTTPS da página de origem oficial do banner (opcional)')
      .setRequired(false)
      .setMaxLength(512));
}

function readQuestFields(interaction) {
  return {
    name: interaction.options.getString('nome'),
    promotedContent: interaction.options.getString('conteudo'),
    questType: interaction.options.getString('tipo'),
    requirements: interaction.options.getString('requisitos'),
    reward: interaction.options.getString('recompensa'),
    endsAt: interaction.options.getString('encerramento'),
    platforms: interaction.options.getString('plataformas'),
    sourceUrl: interaction.options.getString('fonte'),
    officialUrl: interaction.options.getString('link_oficial'),
    instructions: interaction.options.getString('como_encontrar'),
    bannerUrl: interaction.options.getString('banner'),
    imageSourceUrl: interaction.options.getString('fonte_imagem'),
  };
}

function buildListResponse(missions) {
  if (!missions.length) {
    return 'Nenhuma Quest ativa e não expirada foi cadastrada.';
  }

  return missions.slice(0, 10).map((mission) => [
    `**${mission.name}** — ${mission.quest_type === 'play' ? 'Play Quest' : 'Video Quest'}`,
    `ID: \`${mission.id}\` · encerra <t:${Math.floor(Date.parse(mission.ends_at) / 1000)}:F>`,
    `Jogo/conteúdo: ${mission.promoted_content} · recompensa: ${mission.reward}`,
  ].join('\n')).join('\n\n').slice(0, 1900);
}

export const missionsCommand = {
  data: new SlashCommandBuilder()
    .setName('missoes')
    .setDescription('Cadastre e divulgue Quests oficiais de forma informativa.')
    .addSubcommand((subcommand) => addQuestFields(
      subcommand.setName('cadastrar').setDescription('Cadastre uma Quest verificada manualmente.'),
      true,
    ))
    .addSubcommand((subcommand) => addQuestFields(
      subcommand
        .setName('atualizar')
        .setDescription('Atualize uma Quest ativa e registre nova verificação.')
        .addStringOption((option) => option
          .setName('id')
          .setDescription('ID da Quest')
          .setRequired(true)
          .setMaxLength(36)),
      false,
    ))
    .addSubcommand((subcommand) => subcommand
      .setName('listar')
      .setDescription('Lista Quests ativas e ainda válidas.')
      .addBooleanOption((option) => option
        .setName('incluir_encerradas')
        .setDescription('Inclui Quests encerradas e indisponíveis.')))
    .addSubcommand((subcommand) => subcommand
      .setName('encerrar')
      .setDescription('Marca uma Quest como encerrada ou indisponível.')
      .addStringOption((option) => option
        .setName('id')
        .setDescription('ID da Quest')
        .setRequired(true)
        .setMaxLength(36))
      .addStringOption((option) => option
        .setName('situacao')
        .setDescription('Situação final')
        .setRequired(true)
        .addChoices(...statusChoices)))
    .addSubcommand((subcommand) => subcommand
      .setName('anunciar')
      .setDescription('Publica ou atualiza o anúncio VANTA da Quest.')
      .addStringOption((option) => option
        .setName('id')
        .setDescription('ID da Quest')
        .setRequired(true)
        .setMaxLength(36))
      .addChannelOption((option) => option
        .setName('canal')
        .setDescription('Canal de anúncio')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName('alertas')
      .setDescription('Configura o canal para alertas de encerramento.')
      .addChannelOption((option) => option
        .setName('canal')
        .setDescription('Canal de alertas; use remover para desativar.')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addBooleanOption((option) => option
        .setName('remover')
        .setDescription('Remove o canal de alertas configurado.')))
    .addSubcommand((subcommand) => subcommand
      .setName('fontes')
      .setDescription('Mostra fontes autorizadas e Quests candidatas para revisão.'))
    .addSubcommand((subcommand) => subcommand
      .setName('descobrir')
      .setDescription('Consulta agora o feed público oficial do Discord Blog.'))
    .addSubcommand((subcommand) => subcommand
      .setName('teste')
      .setDescription('Exibe uma prévia do card visual VANTA sem publicar campanha real.')),

  async execute(interaction, { db }) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Use este comando em um servidor.', ephemeral: true });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    const administrator = isAdmin(interaction, db);
    if (!administrator && !['listar', 'fontes'].includes(subcommand)) {
      await interaction.reply({
        content: 'Somente administradores autorizados podem gerenciar Quests.',
        ephemeral: true,
      });
      return;
    }
    if (!administrator && interaction.options.getBoolean('incluir_encerradas')) {
      await interaction.reply({
        content: 'Somente administradores podem consultar Quests encerradas ou indisponíveis.',
        ephemeral: true,
      });
      return;
    }

    try {
      if (subcommand === 'fontes') {
        const { sources, candidates, candidateCount } = getMissionDiscoveryStatus(db);
        const sourceLines = sources.map((source) => {
          const access = source.access_mode === 'automatic'
            ? source.status === 'operational'
              ? 'automática · operacional'
              : source.status === 'degraded'
                ? `automática · falhou ${source.failure_count} vez(es)`
                : 'automática · ainda não consultada'
            : 'manual · sem API pública documentada ou feed estruturado';
          const lastChecked = source.last_checked_at
            ? ` · consultada <t:${Math.floor(Date.parse(source.last_checked_at) / 1000)}:R>`
            : '';
          const error = source.last_error ? ` · ${source.last_error.slice(0, 150)}` : '';
          return `• **${source.source_name}**: ${access}${lastChecked}${error}`;
        });
        const candidateLines = candidates.map((candidate) => (
          [
            `• [${candidate.title}](${candidate.url})`,
            candidate.image_url ? `  Imagem do feed (verifique antes de usar): ${candidate.image_url}` : '',
          ].filter(Boolean).join('\n')
        ));
        await interaction.reply({
          content: [
            '**Fontes oficiais VANTA MISSIONS**',
            ...sourceLines,
            `Candidatas do feed aguardando verificação manual: **${candidateCount}**`,
            ...(candidateLines.length ? candidateLines : ['Nenhuma candidata aguardando revisão.']),
            'Artigos do blog não são tratados como prova de Quest; a equipe confirma os detalhes antes de cadastrar ou anunciar.',
          ].join('\n').slice(0, 1900),
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (subcommand === 'descobrir') {
        await interaction.deferReply({ ephemeral: true });
        const intervalMinutes = getGuildSettings(db, interaction.guildId)
          .settings.missionDiscoveryIntervalMinutes ?? 60;
        const result = await checkMissionDiscoverySources({
          db,
          intervalMinutes,
          force: true,
        });
        await interaction.editReply(result.ok
          ? `Consulta concluída. ${result.candidateCount ?? 0} artigo(s) relacionado(s) a Quest aguardam revisão manual.`
          : `O feed oficial está indisponível neste momento: ${result.error}`);
        return;
      }

      if (subcommand === 'teste') {
        await interaction.reply({
          ...await buildMissionAnnouncementPreview(),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'cadastrar') {
        const quest = createMission(db, interaction.guildId, interaction.user.id, readQuestFields(interaction));
        await interaction.reply({
          content: `Quest cadastrada manualmente. ID: \`${quest.id}\`. Fonte oficial registrada; última verificação: <t:${Math.floor(Date.parse(quest.last_verified_at) / 1000)}:F>.`,
          ephemeral: true,
        });
        return;
      }
      if (subcommand === 'atualizar') {
        const quest = updateMission(
          db,
          interaction.guildId,
          interaction.user.id,
          interaction.options.getString('id'),
          readQuestFields(interaction),
        );
        await interaction.reply({
          content: `Quest \`${quest.id}\` atualizada. Fonte registrada e verificação renovada.`,
          ephemeral: true,
        });
        return;
      }
      if (subcommand === 'listar') {
        const includeInactive = interaction.options.getBoolean('incluir_encerradas') ?? false;
        const missions = listMissions(db, interaction.guildId, { includeInactive });
        await interaction.reply({
          content: buildListResponse(missions),
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (subcommand === 'encerrar') {
        const quest = setMissionStatus(
          db,
          interaction.guildId,
          interaction.user.id,
          interaction.options.getString('id'),
          interaction.options.getString('situacao'),
        );
        let announcementUpdated = false;
        try {
          announcementUpdated = await syncMissionAnnouncementStatus({
            client: interaction.client,
            quest,
          });
        } catch (error) {
          const errorName = error instanceof Error ? error.name : 'UnknownError';
          console.error(`Falha ao atualizar anúncio de Quest encerrada (${errorName}).`);
        }
        await interaction.reply({
          content: [
            `Quest \`${quest.id}\` marcada como ${quest.status === 'ended' ? 'encerrada' : 'indisponível'}.`,
            quest.announced_message_id && !announcementUpdated
              ? 'O anúncio público não pôde ser atualizado automaticamente; confira o canal e remova o anúncio manualmente se necessário.'
              : '',
          ].filter(Boolean).join('\n'),
          ephemeral: true,
        });
        return;
      }
      if (subcommand === 'anunciar') {
        await interaction.deferReply({ ephemeral: true });
        const result = await publishMission({
          db,
          guild: interaction.guild,
          actorId: interaction.user.id,
          questId: interaction.options.getString('id'),
          channel: interaction.options.getChannel('canal'),
        });
        await interaction.editReply(
          `Anúncio da Quest ${result.updated ? 'atualizado' : 'publicado'}: ${result.message.url}`,
        );
        return;
      }
      if (subcommand === 'alertas') {
        const channel = interaction.options.getChannel('canal');
        const remove = interaction.options.getBoolean('remover') ?? false;
        if (!channel && !remove) {
          throw new MissionError('Selecione um canal ou use remover: true.');
        }
        configureMissionAlerts(
          db,
          interaction.guildId,
          interaction.user.id,
          remove ? null : channel.id,
        );
        await interaction.reply({
          content: remove ? 'Canal de alertas de Quests removido.' : `Alertas de Quests configurados em ${channel}.`,
          ephemeral: true,
        });
      }
    } catch (error) {
      if (!(error instanceof MissionError)) {
        throw error;
      }
      if (interaction.deferred) {
        await interaction.editReply(error.message);
      } else if (interaction.replied) {
        await interaction.followUp({ content: error.message, ephemeral: true });
      } else {
        await interaction.reply({ content: error.message, ephemeral: true });
      }
    }
  },
};
