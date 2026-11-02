import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { emojiComponent } from '../config/emojis.js';
import { getProductImagePath } from '../config/productImages.js';
import { getCartTotals, formatMoney, listProducts } from './commerce.js';
import { getGuildSettings } from './db.js';
import { appendUploadedImageToPanel } from './customization.js';

const sectionLabels = {
  tickets: 'Tickets',
  staff: 'Equipe e permissões',
  shop: 'Compras e catálogo',
  products: 'Produtos e estoque',
  messages: 'Textos dos painéis',
  coupons: 'Cupons',
  images: 'Imagens dos painéis',
  ai: 'Inteligência artificial',
  support: 'Atendimento e logs',
  carts: 'Carrinhos',
  orders: 'Pedidos',
  payments: 'Pagamentos',
  customization: 'Personalização',
  ads: 'Anúncios',
  missions: 'Missões',
  general: 'Configurações gerais',
};

const unavailableSections = {
  carts: 'Consulta de carrinhos pelo painel administrativo não está implementada.',
  orders: 'O schema registra pedidos pendentes, em atendimento e cancelados; pagamentos e conclusão não estão implementados.',
  payments: 'Pix Z.PAY está disponível no checkout. O adaptador VoxPay aguarda confirmação da documentação.',
  ads: 'O gerenciador de anúncios ainda não está implementado.',
  missions: 'O sistema de missões ainda não está implementado.',
  general: 'Configure os canais, cargos e integrações nas seções disponíveis.',
};

function row(component) {
  return new ActionRowBuilder().addComponents(component);
}

function configEmbed(guildId, settings, staffRoleIds, section = null) {
  const title = section ? sectionLabels[section] : 'Config Center';
  const values = [
    `Equipe: ${staffRoleIds.length ? staffRoleIds.map((id) => `<@&${id}>`).join(', ') : 'sem cargos configurados'}`,
    `Canal de tickets: ${settings.ticketCategoryId ? `<#${settings.ticketCategoryId}>` : 'não definido'}`,
    `Canal de compras: ${settings.shopChannelId ? `<#${settings.shopChannelId}>` : 'não definido'}`,
    `Canal de logs: ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'não definido'}`,
    `IA: ${settings.ai?.enabled === false ? 'desativada' : 'disponível quando NVIDIA_API_KEY estiver configurada'}`,
  ];

  return new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(title)
    .setDescription(section
      ? unavailableSections[section]
        ?? 'As alterações são restritas a administradores autorizados e salvas para este servidor.'
      : 'Escolha uma área para configurar. Os valores são salvos por servidor.')
    .addFields({ name: 'Configuração atual', value: values.join('\n') })
    .setFooter({ text: `Servidor ${guildId} · ${BRAND.signature}` });
}

export function configurationPanel(db, guildId) {
  const { settings, staffRoleIds } = getGuildSettings(db, guildId);
  const select = new StringSelectMenuBuilder()
    .setCustomId('cfg:section')
    .setPlaceholder('Escolha o que configurar')
    .addOptions(Object.entries(sectionLabels).map(([value, label]) => ({ value, label })));

  return {
    embeds: [configEmbed(guildId, settings, staffRoleIds)],
    components: [row(select)],
  };
}

function sectionComponents(section, db, guildId) {
  const { settings } = getGuildSettings(db, guildId);
  const rows = [];

  if (section === 'tickets') {
    rows.push(row(new ChannelSelectMenuBuilder()
      .setCustomId('cfg:channel:ticketCategoryId')
      .setPlaceholder('Categoria dos tickets')
      .setChannelTypes(ChannelType.GuildCategory)));
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:modal:ticketWelcome')
      .setLabel('Editar mensagem de abertura')
      .setStyle(ButtonStyle.Primary)));
  } else if (section === 'staff') {
    rows.push(row(new RoleSelectMenuBuilder()
      .setCustomId('cfg:roles:staff')
      .setPlaceholder('Selecionar cargos autorizados')
      .setMinValues(0)
      .setMaxValues(10)));
    rows.push(row(new RoleSelectMenuBuilder()
      .setCustomId('cfg:roles:support')
      .setPlaceholder('Selecionar cargos de atendimento')
      .setMinValues(0)
      .setMaxValues(10)));
  } else if (section === 'shop') {
    rows.push(row(new ChannelSelectMenuBuilder()
      .setCustomId('cfg:channel:shopChannelId')
      .setPlaceholder('Canal do painel de compras')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)));
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:publish:shop')
      .setLabel('Publicar painel de compras')
      .setStyle(ButtonStyle.Success)));
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:modal:shopMessage')
      .setLabel('Editar texto de compras')
      .setStyle(ButtonStyle.Primary)));
  } else if (section === 'products') {
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:product:new')
      .setLabel('Cadastrar produto')
      .setStyle(ButtonStyle.Success)));
    const products = db.prepare(`
      SELECT id, name, active FROM products WHERE guild_id = ? ORDER BY name LIMIT 25
    `).all(guildId);

    if (products.length) {
      rows.push(row(new StringSelectMenuBuilder()
        .setCustomId('cfg:product:edit')
        .setPlaceholder('Editar produto')
        .addOptions(products.map((product) => ({
          label: product.name.slice(0, 100),
          description: product.active ? 'Ativo' : 'Desativado',
          value: product.id,
        })))));
      rows.push(row(new StringSelectMenuBuilder()
        .setCustomId('cfg:product:toggle')
        .setPlaceholder('Ativar ou desativar produto')
        .addOptions(products.map((product) => ({
          label: product.name.slice(0, 100),
          description: product.active ? 'Ativo' : 'Desativado',
          value: product.id,
        })))));
      rows.push(row(new StringSelectMenuBuilder()
        .setCustomId('cfg:product:image')
        .setPlaceholder('Selecionar imagem de produto')
        .addOptions(products.map((product) => ({
          label: product.name.slice(0, 100),
          value: product.id,
        })))));
    }
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:product:history')
      .setLabel('Histórico de alterações')
      .setStyle(ButtonStyle.Secondary)));
  } else if (section === 'messages') {
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:modal:shopMessage')
      .setLabel('Texto do painel de compras')
      .setStyle(ButtonStyle.Primary)));
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:modal:ticketWelcome')
      .setLabel('Mensagem de abertura de ticket')
      .setStyle(ButtonStyle.Primary)));
  } else if (section === 'coupons') {
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:coupon:new')
      .setLabel('Criar cupom')
      .setStyle(ButtonStyle.Success)));
    const coupons = db.prepare(`
      SELECT code, discount_type, discount_value, active FROM coupons
      WHERE guild_id = ? ORDER BY code LIMIT 25
    `).all(guildId);

    if (coupons.length) {
      rows.push(row(new StringSelectMenuBuilder()
        .setCustomId('cfg:coupon:view')
        .setPlaceholder('Consultar e gerenciar cupom')
        .addOptions(coupons.map((coupon) => ({
          label: coupon.code,
          description: `${coupon.active ? 'Ativo' : 'Inativo'} · ${
            coupon.discount_type === 'percent'
              ? `${coupon.discount_value}%`
              : formatMoney(coupon.discount_value)
          }`,
          value: coupon.code,
        })))));
    }
  } else if (section === 'images') {
    const assets = db.prepare(`
      SELECT id, mime_type, created_at FROM image_assets
      WHERE guild_id = ? ORDER BY created_at DESC LIMIT 25
    `).all(guildId);

    if (assets.length) {
      const options = assets.map((asset) => ({
        label: `${asset.mime_type} · ${asset.id.slice(0, 8)}`,
        description: new Date(asset.created_at).toLocaleString('pt-BR'),
        value: asset.id,
      }));
      rows.push(row(new StringSelectMenuBuilder()
        .setCustomId('cfg:image:shop')
        .setPlaceholder('Imagem enviada para o painel de compras')
        .addOptions(options)));
      rows.push(row(new StringSelectMenuBuilder()
        .setCustomId('cfg:image:ticket')
        .setPlaceholder('Imagem enviada para o painel de tickets')
        .addOptions(options)));
    }
  } else if (section === 'ai') {
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:modal:ai')
      .setLabel('Personalidade e modelo')
      .setStyle(ButtonStyle.Primary)));
    rows.push(row(new ButtonBuilder()
      .setCustomId(`cfg:ai:toggle:${settings.ai?.enabled === false ? 'on' : 'off'}`)
      .setLabel(settings.ai?.enabled === false ? 'Ativar IA' : 'Desativar IA')
      .setStyle(settings.ai?.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger)));
  } else if (section === 'support') {
    rows.push(row(new ChannelSelectMenuBuilder()
      .setCustomId('cfg:channel:logChannelId')
      .setPlaceholder('Canal de logs')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)));
    rows.push(row(new ChannelSelectMenuBuilder()
      .setCustomId('cfg:channel:ticketPanelChannelId')
      .setPlaceholder('Canal do painel de atendimento')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)));
    rows.push(row(new UserSelectMenuBuilder()
      .setCustomId('cfg:user:founderUserId')
      .setPlaceholder('Founder para solicitações de GamePass')
      .setMinValues(0)
      .setMaxValues(1)));
    rows.push(row(new ButtonBuilder()
      .setCustomId('cfg:publish:tickets')
      .setLabel('Publicar painel de tickets')
      .setStyle(ButtonStyle.Success)));
  } else if (section === 'customization') {
    rows.push(row(new ChannelSelectMenuBuilder()
      .setCustomId('cfg:channel:customizationCategoryId')
      .setPlaceholder('Categoria das sessões de personalização')
      .setChannelTypes(ChannelType.GuildCategory)));
  }

  return rows;
}

export function configurationSection(db, guildId, section) {
  if (!Object.hasOwn(sectionLabels, section)) {
    throw new Error('Seção de configuração inválida.');
  }

  const { settings, staffRoleIds } = getGuildSettings(db, guildId);

  return {
    embeds: [configEmbed(guildId, settings, staffRoleIds, section)],
    components: sectionComponents(section, db, guildId),
  };
}

export function buildShopView(db, guildId, category = null, page = 0) {
  const categories = db.prepare(`
    SELECT DISTINCT category FROM products
    WHERE guild_id = ? AND active = 1
    ORDER BY category LIMIT 25
  `).all(guildId).map((entry) => entry.category);

  if (categories.length === 0) {
    return { content: 'O catálogo ainda não tem produtos disponíveis.', components: [] };
  }

  const selectedCategory = categories.includes(category) ? category : categories[0];
  const products = db.prepare(`
    SELECT id, name, description, category, price_cents, cost_cents, stock
    FROM products
    WHERE guild_id = ? AND active = 1 AND category = ?
    ORDER BY name
    LIMIT 100
  `).all(guildId, selectedCategory);
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(products.length / pageSize));
  const currentPage = Math.min(Math.max(0, page, 0), pageCount - 1);
  const pageProducts = products.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const { settings } = getGuildSettings(db, guildId);
  const embed = new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle('Catálogo de compras')
    .setDescription(settings.shopMessage || 'Selecione uma categoria e um produto.')
    .addFields({
      name: selectedCategory,
      value: pageProducts.map((product) => {
        const availability = product.stock === 0
          ? 'esgotado'
          : product.stock === null
            ? 'disponível'
            : `estoque ${product.stock}`;
        const price = product.cost_cents === null
          ? 'preço a confirmar pela equipe'
          : formatMoney(product.price_cents);
        const priceChanged = product.cost_cents !== null
          && product.price_cents !== Math.round(product.cost_cents * 1.3);
        return `**${product.name}** — ${price} · ${availability}${priceChanged ? ' · custo/preço precisa ser revisado pela equipe' : ''}\n${product.description}`;
      }).join('\n\n').slice(0, 1024) || 'Nenhum produto nesta categoria.',
    })
    .setFooter({ text: `Página ${currentPage + 1} de ${pageCount} · ${BRAND.signature}` });

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId('shop:category')
    .setPlaceholder('Escolha uma categoria')
    .addOptions(categories.map((name) => ({
      label: name.slice(0, 100),
      value: name,
      default: name === selectedCategory,
      ...(emojiComponent(categoryEmojiPurpose(name))
        ? { emoji: emojiComponent(categoryEmojiPurpose(name)) }
        : {}),
    })));
  const components = [row(categorySelect)];

  const selectableProducts = pageProducts.filter((product) => product.stock !== 0);

  if (selectableProducts.length) {
    components.push(row(new StringSelectMenuBuilder()
      .setCustomId('shop:product')
      .setPlaceholder('Selecione um produto')
      .addOptions(selectableProducts.map((product) => ({
        label: product.name.slice(0, 100),
        description: `${product.cost_cents === null ? 'preço a confirmar' : formatMoney(product.price_cents)} · ${
          product.stock === null ? 'disponível' : `estoque ${product.stock}`
        }`.slice(0, 100),
        value: product.id,
        ...(emojiComponent(categoryEmojiPurpose(product.category))
          ? { emoji: emojiComponent(categoryEmojiPurpose(product.category)) }
          : {}),
      })))));
  }

  if (pageCount > 1) {
    components.push(row(
      new ButtonBuilder()
        .setCustomId(`shop:page:${Buffer.from(selectedCategory).toString('base64url')}:${Math.max(0, currentPage - 1)}`)
        .setLabel('Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`shop:page:${Buffer.from(selectedCategory).toString('base64url')}:${Math.min(pageCount - 1, currentPage + 1)}`)
        .setLabel('Próxima')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= pageCount - 1),
    ));
  }

  return { embeds: [embed], components };
}

export function buildProductDetailView(db, guildId, product) {
  const embed = new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(product.name)
    .setDescription(product.description)
    .addFields(
      {
        name: 'Preço',
        value: product.cost_cents === null
          ? 'A confirmar com a equipe'
          : formatMoney(product.price_cents),
        inline: true,
      },
      {
        name: 'Disponibilidade',
        value: product.stock === 0
          ? 'Esgotado'
          : product.stock === null
            ? 'Disponível'
            : `${product.stock} em estoque`,
        inline: true,
      },
    );
  let view = {
    embeds: [embed],
    components: [row(new ButtonBuilder()
      .setCustomId(`shop:add:${product.id}`)
      .setLabel(product.cost_cents === null ? 'Solicitar confirmação à equipe' : 'Adicionar ao carrinho')
      .setStyle(product.cost_cents === null ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(product.stock === 0))],
  };

  if (product.image_asset_id) {
    view = appendUploadedImageToPanel({
      db,
      guildId,
      assetId: product.image_asset_id,
      view,
      kind: 'product',
    });
  } else if (typeof product.category === 'string' && typeof product.name === 'string') {
    const imagePath = getProductImagePath(product.category, product.name);
    if (existsSync(imagePath)) {
      const imageName = basename(imagePath);
      embed.setImage(`attachment://${imageName}`);
      view.files = [new AttachmentBuilder(readFileSync(imagePath), { name: imageName })];
    }
  }

  return {
    ...view,
    embeds: [withBrandSignature(view.embeds[0])],
  };
}

export function buildQuantityModal(productId, prefix = 'shop', quantity = 1) {
  return new ModalBuilder()
    .setCustomId(`${prefix}:quantity:${productId}`)
    .setTitle('Definir quantidade')
    .addComponents(row(new TextInputBuilder()
      .setCustomId('quantity')
      .setLabel('Quantidade')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(3)
      .setValue(String(quantity))));
}

export function buildCartView(db, guildId, userId) {
  const cart = getCartTotals(db, guildId, userId);

  if (cart.items.length === 0) {
    return { content: 'Seu carrinho está vazio.', components: [] };
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle('Seu carrinho')
    .setDescription(cart.items.map((item) => {
      const priceChanged = item.cost_cents !== null
        && item.price_cents !== Math.round(item.cost_cents * 1.3);
      return `**${item.name}** × ${item.quantity} — ${formatMoney(item.unit_price_cents * item.quantity)}${priceChanged ? ' · preço alterado, revise antes de confirmar' : ''}`;
    }).join('\n').slice(0, 4000))
    .addFields(
      { name: 'Subtotal', value: formatMoney(cart.subtotalCents), inline: true },
      { name: 'Desconto', value: formatMoney(cart.discountCents), inline: true },
      { name: 'Total', value: formatMoney(cart.totalCents), inline: true },
      { name: 'Cupom', value: cart.couponCode || 'Nenhum', inline: true },
    );
  const rows = [];

  if (cart.items.length) {
    rows.push(row(new StringSelectMenuBuilder()
      .setCustomId('cart:edit')
      .setPlaceholder('Alterar quantidade ou remover produto')
      .addOptions(cart.items.slice(0, 25).map((item) => ({
        label: item.name.slice(0, 100),
        description: `Quantidade atual: ${item.quantity}`,
        value: item.product_id,
      })))));
  }

  rows.push(row(
    new ButtonBuilder()
      .setCustomId('cart:coupon')
      .setLabel('Aplicar cupom')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('cart:checkout')
      .setLabel('Confirmar pedido')
      .setStyle(ButtonStyle.Success),
  ));

  return { embeds: [withBrandSignature(embed)], components: rows };
}

function categoryEmojiPurpose(category) {
  const normalized = category.toLowerCase();
  if (normalized.includes('spotify')) return 'spotify';
  if (normalized.includes('youtube')) return 'youtube';
  if (normalized.includes('robux')) return 'robux';
  if (normalized.includes('nitro')) return 'nitro';
  if (normalized.includes('discord')) return 'discordAccounts';
  if (normalized.includes('impulso')) return 'boosts';
  if (normalized.includes('gamepass')) return 'gamepass';
  return 'product';
}

export function couponSummary(db, guildId, code) {
  const coupon = db.prepare(`
    SELECT code, discount_type, discount_value, valid_from, valid_until, max_uses,
      min_cents, active FROM coupons WHERE guild_id = ? AND code = ?
  `).get(guildId, code.toUpperCase());

  if (!coupon) {
    return null;
  }

  const uses = db.prepare(
    'SELECT COUNT(*) AS count FROM coupon_uses WHERE guild_id = ? AND coupon_code = ?',
  ).get(guildId, coupon.code).count;

  return { ...coupon, uses };
}
