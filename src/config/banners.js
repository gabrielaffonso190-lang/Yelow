export const OFFICIAL_BANNERS = Object.freeze({
  discord_accounts: Object.freeze({
    label: 'Contas Discord',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743028/Banner_Minimalista_de_Contas_Discord.png',
  }),
  discord_nitro: Object.freeze({
    label: 'Discord Nitro',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743028/Banner_promocional_Discord_Nitro_monocrom%C3%A1tico.png',
  }),
  discord_boosts: Object.freeze({
    label: 'Impulsos de servidor Discord',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743028/Promo%C3%A7%C3%A3o_de_Boosts_para_Servidores_Discord.png',
  }),
  spotify_accounts: Object.freeze({
    label: 'Contas Spotify',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743027/Banner_promocional_de_contas_Spotify_em_preto_e_branco.png',
  }),
  spotify_premium: Object.freeze({
    label: 'Spotify Premium',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743027/Banner_promocional_Spotify_Premium_em_preto_e_branco.png',
  }),
  youtube_premium: Object.freeze({
    label: 'YouTube Premium',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743027/Banner_Monocrom%C3%A1tico_YouTube_Premium.png',
  }),
  roblox_gamepass: Object.freeze({
    label: 'Roblox GamePass',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743027/Banner_promocional_Gamepass_Roblox_em_preto_e_branco.png',
  }),
  robux: Object.freeze({
    label: 'Robux',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743027/Banner_promocional_de_Robux_em_dourado.png',
  }),
  payments: Object.freeze({
    label: 'Pagamentos',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743029/Pagamentos_seguros_com_Vanta_Util.png',
  }),
  cart: Object.freeze({
    label: 'Carrinho',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743027/Aguarde__compra_no_carrinho.png',
  }),
  contributor: Object.freeze({
    label: 'Contribuidor e Parcerias',
    url: 'https://res.cloudinary.com/jqumjzav/image/upload/v1793743026/Banner_de_Contribuidor_VantaUtil.png',
  }),
});

export function getBannerUrl(db, guildId, key) {
  const official = OFFICIAL_BANNERS[key];
  if (!official) throw new Error('Chave de banner inválida.');
  if (!db || !guildId) return official.url;
  const row = db.prepare('SELECT settings FROM guild_config WHERE guild_id = ?').get(guildId);
  if (!row) return official.url;
  const settings = JSON.parse(row.settings);
  const override = settings.bannerUrls?.[key];
  return typeof override === 'string' && override.trim() ? override : official.url;
}

export function getCategoryBannerKey(category) {
  const normalized = category.toLowerCase();
  if (normalized.includes('contas discord')) return 'discord_accounts';
  if (normalized.includes('nitro')) return 'discord_nitro';
  if (normalized.includes('impulso')) return 'discord_boosts';
  if (normalized.includes('contas spotify')) return 'spotify_accounts';
  if (normalized.includes('spotify')) return 'spotify_premium';
  if (normalized.includes('youtube')) return 'youtube_premium';
  if (normalized.includes('gamepass')) return 'roblox_gamepass';
  if (normalized.includes('robux')) return 'robux';
  return null;
}