import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import {
  calculateSalePrice,
  createCoupon,
  CommerceError,
  deleteCoupon,
  formatMoney,
  updateCoupon,
} from './commerce.js';
import {
  getGuildSettings,
  updateGuildSettings,
  updateStaffRoles,
  writeAuditLog,
} from './db.js';
import { appendUploadedImageToPanel, buildSupportPanel } from './customization.js';
import { isAdmin } from './permissions.js';
import { buildShopView, configurationSection } from './ui.js';
import { DEFAULT_NVIDIA_MODEL } from './nvidia.js';
import { checkMissionDiscoverySources } from './missionDiscovery.js';
import { buildMissionAnnouncementPreview } from './missions.js';

const allowedModels = new Set([DEFAULT_NVIDIA_MODEL]);
const panelOperations = new Map();

function modalInput(customId, label, options = {}) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(options.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(options.required ?? true)
    .setMaxLength(options.maxLength ?? 100);

  if (options.value) {
    input.setValue(options.value.slice(0, options.maxLength ?? 100));
  } else if (options.placeholder) {
    input.setPlaceholder(options.placeholder);
  }

  return new ActionRowBuilder().addComponents(input);
}

function replyEphemeral(interaction, content) {
  return interaction.reply({ content, ephemeral: true });
}

function parseCurrency(value, label) {
  const normalized = value.trim().replace(',', '.');

  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(normalized)) {
    throw new CommerceError(`${label} deve ser um valor monetário válido.`);
  }

  const cents = Math.round(Number(normalized) * 100);

  if (!Number.isSafeInteger(cents)) {
    throw new CommerceError(`${label} é inválido.`);
  }

  return cents;
}

function parseOptionalCount(value, label, maximum = 1_000_000) {
  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new CommerceError(`${label} deve ser um número inteiro positivo.`);
  }

  const number = Number(normalized);

  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new CommerceError(`${label} deve estar entre 1 e ${maximum}.`);
  }

  return number;
}

function parseStock(value) {
  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new CommerceError('O estoque deve ser um inteiro igual ou maior que zero.');
  }

  const stock = Number(normalized);
  if (!Number.isSafeInteger(stock) || stock > 1_000_000) {
    throw new CommerceError('O estoque deve estar entre 0 e 1.000.000.');
  }

  return stock;
}

function parseExpiry(value) {
  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new CommerceError('A validade deve usar o formato AAAA-MM-DD.');
  }

  const date = new Date(`${normalized}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new CommerceError('Data de validade inválida.');
  }

  return date.toISOString();
}

function requireAuthorized(interaction, db) {
  if (!interaction.inGuild() || !isAdmin(interaction, db)) {
    throw new CommerceError('Somente administradores autorizados podem alterar estas configurações.');
  }
}

function audit(interaction, db, action, details) {
  writeAuditLog(db, interaction.guildId, interaction.user.id, action, details);
}

async function publishPanel({ db, guild, channel, setting, view }) {
  const lockKey = `${guild.id}:${setting}`;
  if (panelOperations.has(lockKey)) {
    return panelOperations.get(lockKey);
  }

  const operation = (async () => {
    const { settings } = getGuildSettings(db, guild.id);
    const messageId = settings[`${setting}MessageId`];
    const previousChannelId = settings[`${setting}MessageChannelId`];

    if (messageId && previousChannelId === channel.id) {
      try {
        return await (await channel.messages.fetch(messageId)).edit(view);
      } catch (error) {
        if (error?.code !== 10008) {
          throw error;
        }
      }
    } else if (messageId && previousChannelId) {
      const previousChannel = await guild.channels.fetch(previousChannelId).catch((error) => {
        if (error?.code === 10003) {
          return null;
        }
        throw error;
      });
      if (previousChannel?.isTextBased() && previousChannel.messages) {
        const previousMessage = await previousChannel.messages.fetch(messageId).catch((error) => {
          if (error?.code === 10008) {
            return null;
          }
          throw error;
        });
        if (previousMessage) {
          await previousMessage.edit({
            content: 'Este painel foi movido para outro canal.',
            embeds: [],
            components: [],
          });
        }
      }
    }

    const message = await channel.send(view);
    updateGuildSettings(db, guild.id, {
      [`${setting}MessageId`]: message.id,
      [`${setting}MessageChannelId`]: channel.id,
    });
    return message;
  })();

  panelOperations.set(lockKey, operation);
  try {
    return await operation;
  } finally {
    panelOperations.delete(lockKey);
  }
}

function openProductModal(interaction, product = null) {
  const modal = new ModalBuilder()
    .setCustomId(product ? `cfg:product:save:${product.id}` : 'cfg:product:create')
    .setTitle(product ? 'Editar produto' : 'Cadastrar produto')
    .addComponents(
      modalInput('name', 'Nome', { value: product?.name, maxLength: 80 }),
      modalInput('description', 'Descrição', {
        value: product?.description,
        maxLength: 300,
        paragraph: true,
      }),
      modalInput('cost', 'Custo do fornecedor em R$ (ex.: 49,90)', {
        value: product?.cost_cents === null || product?.cost_cents === undefined
          ? undefined
          : (product.cost_cents / 100).toFixed(2).replace('.', ','),
      }),
      modalInput('category', 'Categoria', {
        value: product?.category,
        placeholder: 'Geral',
        maxLength: 80,
      }),
      modalInput('stock', 'Estoque (vazio = ilimitado)', {
        value: product?.stock === null ? '' : String(product?.stock ?? ''),
        required: false,
        maxLength: 6,
      }),
    );

  return interaction.showModal(modal);
}

export async function handleConfigurationComponent(interaction, services) {
  const { db } = services;
  requireAuthorized(interaction, db);
  const [namespace, action, key, value] = interaction.customId.split(':');

  if (namespace !== 'cfg') {
    return false;
  }

  if (interaction.isStringSelectMenu() && action === 'section') {
    await interaction.update(configurationSection(db, interaction.guildId, interaction.values[0]));
    return true;
  }

  if (interaction.isChannelSelectMenu() && action === 'channel') {
    const channelId = interaction.channels.first()?.id ?? null;
    const channelSettings = new Set([
      'ticketCategoryId',
      'customizationCategoryId',
      'shopChannelId',
      'logChannelId',
      'ticketPanelChannelId',
      'missionAnnouncementChannelId',
    ]);
    const allowedChannels = new Set([
      ChannelType.GuildCategory,
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
    ]);

    if (!channelSettings.has(key)) {
      await replyEphemeral(interaction, 'Configuração de canal inválida.');
      return true;
    }

    if (channelId && !allowedChannels.has(interaction.channels.first().type)) {
      await replyEphemeral(interaction, 'Tipo de canal inválido para esta configuração.');
      return true;
    }

    const previousChannelId = getGuildSettings(db, interaction.guildId).settings[key] ?? null;
    updateGuildSettings(db, interaction.guildId, { [key]: channelId });
    audit(interaction, db, 'config.channel.updated', {
      setting: key,
      previousChannelId,
      channelId,
    });
    await interaction.reply({
      content: channelId ? `Configuração salva em <#${channelId}>.` : 'Canal removido da configuração.',
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isUserSelectMenu() && action === 'user' && key === 'founderUserId') {
    const userId = interaction.users.first()?.id ?? null;
    const previousUserId = getGuildSettings(db, interaction.guildId).settings.founderUserId ?? null;
    updateGuildSettings(db, interaction.guildId, { founderUserId: userId });
    audit(interaction, db, 'config.founder.updated', {
      previousUserId,
      userId,
    });
    await replyEphemeral(interaction, userId
      ? 'Founder definido para solicitações personalizadas.'
      : 'Founder removido da configuração.');
    return true;
  }

  if (interaction.isRoleSelectMenu() && action === 'roles') {
    if (!['staff', 'support'].includes(key)) {
      await replyEphemeral(interaction, 'Grupo de cargos inválido.');
      return true;
    }

    const roleIds = interaction.values;
    const { settings, staffRoleIds } = getGuildSettings(db, interaction.guildId);
    const previousRoleIds = key === 'staff'
      ? staffRoleIds
      : (Array.isArray(settings.supportRoleIds) ? settings.supportRoleIds : []);

    if (key === 'staff') {
      updateStaffRoles(db, interaction.guildId, roleIds);
    } else {
      updateGuildSettings(db, interaction.guildId, { supportRoleIds: roleIds });
    }

    audit(interaction, db, 'config.roles.updated', {
      group: key,
      previousRoleIds,
      roleIds,
    });
    await replyEphemeral(interaction, 'Cargos autorizados atualizados.');
    return true;
  }

  if (interaction.isButton() && action === 'product' && key === 'new') {
    await openProductModal(interaction);
    return true;
  }

  if (interaction.isButton() && action === 'product' && key === 'history') {
    const records = db.prepare(`
      SELECT actor_id, action, details, created_at FROM audit_logs
      WHERE guild_id = ? AND action IN (
        'product.created', 'product.updated', 'product.toggled', 'product.image.updated'
      )
      ORDER BY id DESC LIMIT 10
    `).all(interaction.guildId);
    const history = records.length
      ? records.map((record) => {
        let details;
        try {
          details = JSON.parse(record.details);
        } catch {
          return `• <@${record.actor_id}> — ${record.action} — ${record.created_at} — detalhes inválidos`;
        }

        const cost = (value) => value === null || value === undefined
          ? 'não definido'
          : formatMoney(value);
        let changes = '';
        if (details.previous && details.next) {
          changes = [
            `nome: ${details.previous.name} → ${details.next.name}`,
            `categoria: ${details.previous.category} → ${details.next.category}`,
            `custo: ${cost(details.previous.costCents)} → ${cost(details.next.costCents)}`,
            `preço: ${cost(details.previous.priceCents)} → ${cost(details.next.priceCents)}`,
            `estoque: ${details.previous.stock ?? 'ilimitado'} → ${details.next.stock ?? 'ilimitado'}`,
          ].join(' · ');
        } else if (Object.hasOwn(details, 'previousActive')) {
          changes = `ativo: ${details.previousActive ? 'sim' : 'não'} → ${details.active ? 'sim' : 'não'}`;
        } else if (Object.hasOwn(details, 'previousImageId')) {
          changes = `imagem: ${details.previousImageId ?? 'nenhuma'} → ${details.imageId ?? 'nenhuma'}`;
        } else if (details.name) {
          changes = `produto: ${details.name}; custo: ${cost(details.costCents)}; preço: ${cost(details.priceCents)}; estoque: ${details.stock ?? 'ilimitado'}`;
        }

        return `• <@${record.actor_id}> — ${record.action} — ${record.created_at}${changes ? `\n  ${changes}` : ''}`;
      }).join('\n')
      : 'Ainda não há alterações registradas para produtos.';
    await interaction.reply({
      content: history.length > 1900 ? `${history.slice(0, 1880)}\n… histórico reduzido` : history,
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && action === 'product' && key === 'toggle') {
    const productId = interaction.values[0];
    const product = db.prepare(`
      SELECT name, active FROM products WHERE guild_id = ? AND id = ?
    `).get(interaction.guildId, productId);

    if (!product) {
      await replyEphemeral(interaction, 'Produto não encontrado.');
      return true;
    }

    const active = product.active ? 0 : 1;
    db.prepare('UPDATE products SET active = ? WHERE guild_id = ? AND id = ?')
      .run(active, interaction.guildId, productId);
    audit(interaction, db, 'product.toggled', {
      productId,
      previousActive: product.active,
      active,
    });
    await replyEphemeral(interaction, `${product.name} ${active ? 'ativado' : 'desativado'}.`);
    return true;
  }

  if (interaction.isButton() && action === 'modal') {
    if (key === 'ai') {
      const { settings } = getGuildSettings(db, interaction.guildId);
      await interaction.showModal(createAiConfigModal(settings.ai));
      return true;
    }

    const settingByModal = {
      shopMessage: 'shopMessage',
      ticketWelcome: 'ticketWelcome',
    };
    const setting = settingByModal[key];

    if (!setting) {
      return false;
    }

    const { settings } = getGuildSettings(db, interaction.guildId);
    const modal = new ModalBuilder()
      .setCustomId(`cfg:modal:${setting}`)
      .setTitle(setting === 'shopMessage' ? 'Texto do painel de compras' : 'Mensagem de abertura de ticket')
      .addComponents(modalInput('value', 'Texto', {
        value: settings[setting] || '',
        paragraph: true,
        maxLength: 1500,
      }));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isStringSelectMenu() && action === 'product' && key === 'edit') {
    const product = db.prepare(`
      SELECT id, name, description, category, cost_cents, price_cents, stock
      FROM products WHERE guild_id = ? AND id = ?
    `).get(interaction.guildId, interaction.values[0]);

    if (!product) {
      await replyEphemeral(interaction, 'Produto não encontrado.');
      return true;
    }

    await openProductModal(interaction, product);
    return true;
  }

  if (interaction.isStringSelectMenu() && action === 'product' && key === 'image') {
    const productId = interaction.values[0];
    const product = db.prepare(`
      SELECT id, name FROM products WHERE guild_id = ? AND id = ?
    `).get(interaction.guildId, productId);

    if (!product) {
      await replyEphemeral(interaction, 'Produto não encontrado.');
      return true;
    }

    const assets = db.prepare(`
      SELECT id, mime_type, created_at FROM image_assets
      WHERE guild_id = ? ORDER BY created_at DESC LIMIT 24
    `).all(interaction.guildId);

    if (assets.length === 0) {
      await replyEphemeral(interaction, 'Envie uma imagem em um canal de personalização antes de associá-la ao produto.');
      return true;
    }

    await interaction.reply({
      content: `Escolha a imagem de **${product.name}**:`,
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cfg:product:image-set:${product.id}`)
          .setPlaceholder('Imagem enviada no Discord')
          .addOptions([
            { label: 'Remover imagem', value: 'none' },
            ...assets.map((asset) => ({
              label: `${asset.mime_type} · ${asset.id.slice(0, 8)}`,
              description: new Date(asset.created_at).toLocaleString('pt-BR'),
              value: asset.id,
            })),
          ]),
      )],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && action === 'product' && key === 'image-set') {
    const productId = value;
    const imageId = interaction.values[0];
    const product = db.prepare(`
      SELECT id, image_asset_id FROM products WHERE guild_id = ? AND id = ?
    `).get(interaction.guildId, productId);

    if (!product) {
      await replyEphemeral(interaction, 'Produto não encontrado.');
      return true;
    }

    if (imageId !== 'none' && !db.prepare(`
      SELECT id FROM image_assets WHERE guild_id = ? AND id = ?
    `).get(interaction.guildId, imageId)) {
      await replyEphemeral(interaction, 'A imagem selecionada não existe neste servidor.');
      return true;
    }

    db.prepare(`
      UPDATE products SET image_asset_id = ? WHERE guild_id = ? AND id = ?
    `).run(imageId === 'none' ? null : imageId, interaction.guildId, productId);
    audit(interaction, db, 'product.image.updated', {
      productId,
      previousImageId: product.image_asset_id,
      imageId: imageId === 'none' ? null : imageId,
    });
    await interaction.update({
      content: imageId === 'none' ? 'Imagem removida do produto.' : 'Imagem do produto atualizada.',
      components: [],
    });
    return true;
  }

  if (interaction.isButton() && action === 'coupon' && key === 'new') {
    const modal = new ModalBuilder()
      .setCustomId('cfg:coupon:create')
      .setTitle('Criar cupom')
      .addComponents(
        modalInput('code', 'Código', { maxLength: 32 }),
        modalInput('type', 'Tipo: percent ou fixed', { placeholder: 'percent' }),
        modalInput('value', 'Desconto (% ou valor em R$)', { maxLength: 12 }),
        modalInput('expires', 'Validade AAAA-MM-DD (opcional)', {
          required: false,
          maxLength: 10,
        }),
        modalInput('limits', 'Limite de usos e mínimo em R$: usos,mínimo', {
          placeholder: '100,50.00',
          required: false,
          maxLength: 30,
        }),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isStringSelectMenu() && action === 'coupon' && key === 'view') {
    const coupon = db.prepare(
      'SELECT code, discount_type, discount_value, active, valid_until, max_uses, min_cents FROM coupons WHERE guild_id = ? AND code = ?',
    ).get(interaction.guildId, interaction.values[0]);

    if (!coupon) {
      await replyEphemeral(interaction, 'Cupom não encontrado.');
      return true;
    }

    const used = db.prepare(
      'SELECT COUNT(*) AS count FROM coupon_uses WHERE guild_id = ? AND coupon_code = ?',
    ).get(interaction.guildId, coupon.code).count;
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`Cupom ${coupon.code}`)
        .setDescription([
          `Desconto: ${coupon.discount_type === 'percent' ? `${coupon.discount_value}%` : `R$ ${(coupon.discount_value / 100).toFixed(2)}`}`,
          `Estado: ${coupon.active ? 'ativo' : 'inativo'}`,
          `Validade: ${coupon.valid_until || 'sem validade'}`,
          `Utilizações: ${used}/${coupon.max_uses ?? 'ilimitadas'}`,
          `Pedido mínimo: R$ ${(coupon.min_cents / 100).toFixed(2)}`,
        ].join('\n'))],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg:coupon:toggle:${coupon.code}`)
          .setLabel(coupon.active ? 'Desativar' : 'Ativar')
          .setStyle(coupon.active ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cfg:coupon:edit:${coupon.code}`)
          .setLabel('Editar')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`cfg:coupon:delete:${coupon.code}`)
          .setLabel('Excluir')
          .setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isButton() && action === 'coupon' && key === 'toggle') {
    const coupon = db.prepare(
      'SELECT active FROM coupons WHERE guild_id = ? AND code = ?',
    ).get(interaction.guildId, value);

    if (!coupon) {
      await replyEphemeral(interaction, 'Cupom não encontrado.');
      return true;
    }

    const active = coupon.active ? 0 : 1;
    db.prepare('UPDATE coupons SET active = ? WHERE guild_id = ? AND code = ?')
      .run(active, interaction.guildId, value);
    audit(interaction, db, 'coupon.toggled', {
      code: value,
      previousActive: coupon.active,
      active,
    });
    await replyEphemeral(interaction, `Cupom ${value} ${active ? 'ativado' : 'desativado'}.`);
    return true;
  }

  if (interaction.isButton() && action === 'coupon' && key === 'edit') {
    const coupon = db.prepare(`
      SELECT * FROM coupons WHERE guild_id = ? AND code = ?
    `).get(interaction.guildId, value);

    if (!coupon) {
      await replyEphemeral(interaction, 'Cupom não encontrado.');
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`cfg:coupon:edit:${coupon.code}`)
      .setTitle(`Editar cupom ${coupon.code}`)
      .addComponents(
        modalInput('type', 'Tipo: percent ou fixed', { value: coupon.discount_type }),
        modalInput('value', 'Desconto (% ou valor em R$)', {
          value: coupon.discount_type === 'fixed'
            ? (coupon.discount_value / 100).toFixed(2)
            : String(coupon.discount_value),
          maxLength: 12,
        }),
        modalInput('expires', 'Validade AAAA-MM-DD (opcional)', {
          value: coupon.valid_until?.slice(0, 10) || '',
          required: false,
          maxLength: 10,
        }),
        modalInput('limits', 'Limite de usos e mínimo em R$: usos,mínimo', {
          value: `${coupon.max_uses ?? ''},${(coupon.min_cents / 100).toFixed(2)}`,
          required: false,
          maxLength: 30,
        }),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isButton() && action === 'coupon' && key === 'delete') {
    const coupon = db.prepare(
      'SELECT discount_type, discount_value, active FROM coupons WHERE guild_id = ? AND code = ?',
    ).get(interaction.guildId, value);
    if (!coupon) {
      await replyEphemeral(interaction, 'Cupom não encontrado.');
      return true;
    }

    await interaction.reply({
      content: `Confirma excluir o cupom **${value}**?`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg:coupon:delete-confirm:${value}`)
          .setLabel('Confirmar exclusão')
          .setStyle(ButtonStyle.Danger),
      )],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isButton() && action === 'coupon' && key === 'delete-confirm') {
    const coupon = db.prepare(`
      SELECT discount_type, discount_value, active FROM coupons
      WHERE guild_id = ? AND code = ?
    `).get(interaction.guildId, value);
    if (!deleteCoupon(db, interaction.guildId, value)) {
      await replyEphemeral(interaction, 'Cupom não encontrado.');
      return true;
    }

    audit(interaction, db, 'coupon.deleted', {
      code: value,
      previous: coupon,
      next: null,
    });
    await interaction.update({ content: `Cupom ${value} excluído.`, components: [], embeds: [] });
    return true;
  }

  if (interaction.isStringSelectMenu() && action === 'image') {
    const asset = db.prepare(`
      SELECT id, file_path, mime_type FROM image_assets
      WHERE id = ? AND guild_id = ?
    `).get(interaction.values[0], interaction.guildId);

    if (!asset) {
      await replyEphemeral(interaction, 'Imagem não encontrada neste servidor.');
      return true;
    }

    if (!['shop', 'ticket'].includes(key)) {
      await replyEphemeral(interaction, 'Destino da imagem inválido.');
      return true;
    }
    const setting = key === 'shop' ? 'shopImageAssetId' : 'ticketImageAssetId';
    updateGuildSettings(db, interaction.guildId, { [setting]: asset.id });
    audit(interaction, db, 'config.image.selected', { setting, assetId: asset.id });
    await replyEphemeral(interaction, 'Imagem selecionada. Ela permanece privada no armazenamento do bot.');
    return true;
  }

  if (interaction.isButton() && action === 'ai' && key === 'toggle') {
    const enabled = value === 'on';
    const { settings } = getGuildSettings(db, interaction.guildId);
    updateGuildSettings(db, interaction.guildId, {
      ai: { ...settings.ai, enabled },
    });
    audit(interaction, db, 'config.ai.toggled', {
      previousEnabled: settings.ai?.enabled !== false,
      enabled,
    });
    await replyEphemeral(interaction, `IA ${enabled ? 'ativada' : 'desativada'} para este servidor.`);
    return true;
  }

  if (interaction.isButton() && action === 'mission') {
    const { settings } = getGuildSettings(db, interaction.guildId);
    if (key === 'auto' || key === 'approval') {
      if (key === 'auto' && !settings.missionAutomationEnabled
        && !settings.missionAnnouncementChannelId) {
        await replyEphemeral(interaction, 'Configure primeiro o canal de anúncios de VANTA MISSIONS.');
        return true;
      }

      const setting = key === 'auto'
        ? 'missionAutomationEnabled'
        : 'missionRequireApproval';
      const nextValue = key === 'auto'
        ? !settings.missionAutomationEnabled
        : settings.missionRequireApproval === false;
      updateGuildSettings(db, interaction.guildId, { [setting]: nextValue });
      audit(interaction, db, `config.missions.${key}.updated`, { enabled: nextValue });
      await interaction.update(configurationSection(db, interaction.guildId, 'missions'));
      return true;
    }

    if (key === 'interval' || key === 'mentions') {
      const modal = new ModalBuilder()
        .setCustomId(`cfg:modal:mission${key === 'interval' ? 'Interval' : 'Mentions'}`)
        .setTitle(key === 'interval' ? 'Intervalo de consulta' : 'Menções de VANTA MISSIONS')
        .addComponents(key === 'interval'
          ? modalInput('interval', 'Minutos (15 a 1.440)', {
            value: String(settings.missionDiscoveryIntervalMinutes ?? 60),
            maxLength: 4,
          })
          : modalInput('roles', 'IDs de cargos separados por vírgula', {
            value: (settings.missionAllowedRoleIds ?? []).join(','),
            placeholder: 'Vazio para não mencionar cargos',
            paragraph: true,
            required: false,
            maxLength: 250,
          }));
      await interaction.showModal(modal);
      return true;
    }

    if (key === 'preview') {
      await interaction.reply({
        ...await buildMissionAnnouncementPreview(),
        ephemeral: true,
      });
      return true;
    }

    if (key === 'check') {
      await interaction.deferReply({ ephemeral: true });
      const result = await checkMissionDiscoverySources({
        db,
        intervalMinutes: settings.missionDiscoveryIntervalMinutes ?? 60,
        force: true,
      });
      await interaction.editReply(result.ok
        ? `Consulta concluída. ${result.candidateCount ?? 0} artigo(s) relacionado(s) a Quest aguardam revisão manual.`
        : `A fonte automática está indisponível: ${result.error}`);
      return true;
    }
  }

  if (interaction.isButton() && action === 'publish') {
    const { settings } = getGuildSettings(db, interaction.guildId);
    const channelId = key === 'shop' ? settings.shopChannelId : settings.ticketPanelChannelId;
    const channel = channelId
      ? await interaction.guild.channels.fetch(channelId).catch((error) => {
        if (error?.code === 10003) {
          return null;
        }

        throw error;
      })
      : null;

    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      await replyEphemeral(interaction, 'Configure um canal de texto acessível antes de publicar o painel.');
      return true;
    }

    if (key === 'shop') {
      let view = buildShopView(db, interaction.guildId);
      if (view.content && !view.embeds?.length) {
        await replyEphemeral(interaction, view.content);
        return true;
      }

      if (settings.shopImageAssetId) {
        view = appendUploadedImageToPanel({
          db,
          guildId: interaction.guildId,
          assetId: settings.shopImageAssetId,
          view,
          kind: 'shop',
        });
      }

      const message = await publishPanel({
        db,
        guild: interaction.guild,
        channel,
        setting: 'shopPanel',
        view,
      });
      audit(interaction, db, 'panel.shop.published', { channelId });
      await replyEphemeral(interaction, `Painel de compras publicado ou atualizado em <#${channelId}> (${message.id}).`);
    } else {
      let view = buildSupportPanel(db, interaction.guildId);
      if (settings.ticketImageAssetId) {
        view = appendUploadedImageToPanel({
          db,
          guildId: interaction.guildId,
          assetId: settings.ticketImageAssetId,
          view,
          kind: 'ticket',
        });
      }

      const message = await publishPanel({
        db,
        guild: interaction.guild,
        channel,
        setting: 'ticketPanel',
        view,
      });
      audit(interaction, db, 'panel.support.published', { channelId });
      await replyEphemeral(interaction, `Painel de atendimento publicado ou atualizado em <#${channelId}> (${message.id}).`);
    }

    return true;
  }

  return false;
}

export async function handleConfigurationModal(interaction, services) {
  const { db } = services;
  requireAuthorized(interaction, db);
  const parts = interaction.customId.split(':');

  if (parts[0] !== 'cfg') {
    return false;
  }

  if (parts[1] === 'modal') {
    const { settings } = getGuildSettings(db, interaction.guildId);

    if (parts[2] === 'ai') {
      const model = interaction.fields.getTextInputValue('model').trim();
      const personality = interaction.fields.getTextInputValue('personality').trim();

      if (!allowedModels.has(model)) {
        await replyEphemeral(interaction, `Modelo inválido. O modelo configurado é ${DEFAULT_NVIDIA_MODEL}.`);
        return true;
      }

      updateGuildSettings(db, interaction.guildId, {
        ai: { ...settings.ai, model, personality },
      });
      audit(interaction, db, 'config.ai.updated', { model });
      await replyEphemeral(interaction, 'Personalidade e modelo da IA salvos.');
      return true;
    }

    if (parts[2] === 'missionInterval') {
      const rawValue = interaction.fields.getTextInputValue('interval').trim();
      if (!/^\d{1,4}$/.test(rawValue)) {
        await replyEphemeral(interaction, 'O intervalo deve ser um número inteiro entre 15 e 1.440 minutos.');
        return true;
      }
      const interval = Number(rawValue);
      if (!Number.isSafeInteger(interval) || interval < 15 || interval > 1440) {
        await replyEphemeral(interaction, 'O intervalo deve ser entre 15 e 1.440 minutos.');
        return true;
      }
      updateGuildSettings(db, interaction.guildId, { missionDiscoveryIntervalMinutes: interval });
      audit(interaction, db, 'config.missions.interval.updated', { intervalMinutes: interval });
      await replyEphemeral(interaction, `Consulta de fontes configurada para cada ${interval} minutos.`);
      return true;
    }

    if (parts[2] === 'missionMentions') {
      const rawValue = interaction.fields.getTextInputValue('roles').trim();
      const roleIds = rawValue
        ? [...new Set(rawValue.split(',').map((id) => id.trim()).filter(Boolean))]
        : [];
      if (roleIds.length > 10
        || roleIds.some((id) => !/^\d{17,20}$/.test(id) || id === interaction.guildId)) {
        await replyEphemeral(interaction, 'Informe até 10 IDs de cargos válidos, separados por vírgula.');
        return true;
      }

      for (const roleId of roleIds) {
        let role;
        try {
          role = await interaction.guild.roles.fetch(roleId);
        } catch (error) {
          if (error?.code === 10011) {
            await replyEphemeral(interaction, `O cargo ${roleId} não existe neste servidor.`);
            return true;
          }
          throw error;
        }
        if (!role) {
          await replyEphemeral(interaction, `O cargo ${roleId} não existe neste servidor.`);
          return true;
        }
      }

      updateGuildSettings(db, interaction.guildId, { missionAllowedRoleIds: roleIds });
      audit(interaction, db, 'config.missions.mentions.updated', { roleIds });
      await replyEphemeral(interaction, roleIds.length
        ? `Menções permitidas atualizadas para ${roleIds.length} cargo(s).`
        : 'Menções de cargos removidas.');
      return true;
    }

    const value = interaction.fields.getTextInputValue('value').trim();

    if (value.length > 1500) {
      await replyEphemeral(interaction, 'O texto excede o limite permitido.');
      return true;
    }

    const setting = parts[2];
    if (!['shopMessage', 'ticketWelcome'].includes(setting)) {
      return false;
    }

    updateGuildSettings(db, interaction.guildId, { [setting]: value });
    audit(interaction, db, 'config.text.updated', { setting });
    await replyEphemeral(interaction, 'Texto salvo para este servidor.');
    return true;
  }

  if (parts[1] === 'product' && (parts[2] === 'create' || parts[2] === 'save')) {
    const productId = parts[2] === 'save' ? parts[3] : null;
    const name = interaction.fields.getTextInputValue('name').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const costCents = parseCurrency(interaction.fields.getTextInputValue('cost'), 'Custo');
    if (costCents <= 0) {
      throw new CommerceError('O custo do fornecedor deve ser maior que zero.');
    }
    const priceCents = calculateSalePrice(costCents);
    const category = interaction.fields.getTextInputValue('category').trim() || 'Geral';
    const stockText = interaction.fields.getTextInputValue('stock').trim();
    const stock = parseStock(stockText);

    if (!name || !description || !category) {
      throw new CommerceError('Nome, descrição e categoria são obrigatórios.');
    }

    if (productId) {
      const previous = db.prepare(`
        SELECT name, cost_cents, price_cents, stock FROM products
        WHERE guild_id = ? AND id = ?
      `).get(interaction.guildId, productId);

      if (!previous) {
        await replyEphemeral(interaction, 'Produto não encontrado.');
        return true;
      }

      const result = db.prepare(`
        UPDATE products
        SET name = ?, description = ?, category = ?, cost_cents = ?, price_cents = ?, stock = ?
        WHERE guild_id = ? AND id = ?
      `).run(name, description, category, costCents, priceCents, stock, interaction.guildId, productId);

      if (!result.changes) {
        await replyEphemeral(interaction, 'Produto não encontrado.');
        return true;
      }

      audit(interaction, db, 'product.updated', {
        productId,
        previous: {
          name: previous.name,
          description: previous.description,
          category: previous.category,
          costCents: previous.cost_cents,
          priceCents: previous.price_cents,
          stock: previous.stock,
        },
        next: {
          name,
          description,
          category,
          costCents,
          priceCents,
          stock,
        },
      });
    } else {
      const productId = randomUUID();
      db.prepare(`
        INSERT INTO products
          (id, guild_id, name, description, category, cost_cents, price_cents, stock, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        productId,
        interaction.guildId,
        name,
        description,
        category,
        costCents,
        priceCents,
        stock,
        new Date().toISOString(),
      );
      audit(interaction, db, 'product.created', {
        productId,
        name,
        category,
        costCents,
        priceCents,
        stock,
      });
    }

    await replyEphemeral(interaction, `Produto ${productId ? 'atualizado' : 'cadastrado'} com sucesso.`);
    return true;
  }

  if (parts[1] === 'coupon' && parts[2] === 'create') {
    const code = interaction.fields.getTextInputValue('code');
    const discountType = interaction.fields.getTextInputValue('type').trim().toLowerCase();
    const value = interaction.fields.getTextInputValue('value').trim();
    const expires = parseExpiry(interaction.fields.getTextInputValue('expires'));
    const limits = interaction.fields.getTextInputValue('limits').trim();
    const [maxUsesText = '', minimumText = ''] = limits.split(',');
    const discountValue = discountType === 'fixed'
      ? parseCurrency(value, 'Desconto')
      : Number(value);
    const minCents = minimumText.trim()
      ? parseCurrency(minimumText, 'Pedido mínimo')
      : 0;
    const maxUses = parseOptionalCount(maxUsesText, 'Limite de usos');

    if (discountType === 'percent' && (!Number.isInteger(discountValue) || discountValue > 100)) {
      throw new CommerceError('O desconto percentual deve ser um inteiro entre 1 e 100.');
    }

    createCoupon(db, {
      guildId: interaction.guildId,
      code,
      discountType,
      discountValue,
      validUntil: expires,
      maxUses,
      minCents,
      createdBy: interaction.user.id,
    });
    await replyEphemeral(interaction, `Cupom ${code.trim().toUpperCase()} criado.`);
    return true;
  }

  if (parts[1] === 'coupon' && parts[2] === 'edit') {
    const code = decodeURIComponent(parts[3] || '');
    const previous = db.prepare(`
      SELECT discount_type, discount_value, valid_until, max_uses, min_cents, active
      FROM coupons WHERE guild_id = ? AND code = ?
    `).get(interaction.guildId, code);
    const discountType = interaction.fields.getTextInputValue('type').trim().toLowerCase();
    const rawValue = interaction.fields.getTextInputValue('value').trim();
    const discountValue = discountType === 'fixed'
      ? parseCurrency(rawValue, 'Desconto')
      : Number(rawValue);
    const validUntil = parseExpiry(interaction.fields.getTextInputValue('expires'));
    const [maxUsesText = '', minimumText = ''] = interaction.fields
      .getTextInputValue('limits')
      .split(',');
    const maxUses = parseOptionalCount(maxUsesText, 'Limite de usos');
    const minCents = minimumText.trim()
      ? parseCurrency(minimumText, 'Pedido mínimo')
      : 0;

    updateCoupon(db, interaction.guildId, code, {
      discountType,
      discountValue,
      validUntil,
      maxUses,
      minCents,
    });
    audit(interaction, db, 'coupon.updated', {
      code,
      previous,
      next: {
        discountType,
        discountValue,
        validUntil,
        maxUses,
        minCents,
      },
    });
    await replyEphemeral(interaction, `Cupom ${code} atualizado.`);
    return true;
  }

  return false;
}

export function createAiConfigModal(ai = {}) {
  return new ModalBuilder()
    .setCustomId('cfg:modal:ai')
    .setTitle('Configurar inteligência artificial')
    .addComponents(
      modalInput('model', 'Modelo NVIDIA', {
        value: DEFAULT_NVIDIA_MODEL,
        placeholder: DEFAULT_NVIDIA_MODEL,
      }),
      modalInput('personality', 'Personalidade em português', {
        value: ai.personality || 'Tecnológica, profissional, natural, prestativa e objetiva.',
        paragraph: true,
        maxLength: 1000,
      }),
    );
}
