const emojiSettings = Object.freeze({
  success: { envNames: ['VANTA_EMOJI_SUCCESS'], id: '1566947592229748756', fallback: '✓' },
  error: { envNames: ['VANTA_EMOJI_ERROR'], id: '1566947606196654120', fallback: '!' },
  warning: { envNames: ['VANTA_EMOJI_WARNING'], id: '1566947583593681077', fallback: '⚠️' },
  loading: { envNames: ['VANTA_EMOJI_LOADING'], id: '1566790827529998407', fallback: '…' },
  discordAccounts: { envNames: ['VANTA_CONTAS_DISCORD_EMOJI_ID'], id: '1567294072698175509', fallback: '💬' },
  spotifyAccounts: { envNames: ['VANTA_CONTAS_SPOTIFY_EMOJI_ID'], id: '1567294060165734522', fallback: '🎧' },
  discordNitro: { envNames: ['VANTA_DISCORD_NITRO_EMOJI_ID'], id: '1567294071230169248', fallback: '✨' },
  gamepass: { envNames: ['VANTA_GAMEPASS_EMOJI_ID'], id: '1567294069728874536', fallback: '🎮' },
  discordBoosts: { envNames: ['VANTA_IMPULSOS_SERVIDOR_EMOJI_ID'], id: '1567294068063608984', fallback: '🚀' },
  robux: { envNames: ['VANTA_ROBUX_EMOJI_ID', 'VANTA_EMOJI_ROBUX'], id: '1567294066222432367', fallback: '🪙' },
  spotifyPremium: { envNames: ['VANTA_SPOTIFY_PREMIUM_EMOJI_ID'], id: '1567294063705587742', fallback: '🎵' },
  youtubePremium: { envNames: ['VANTA_YOUTUBE_PREMIUM_EMOJI_ID'], id: '156729406178906114', fallback: '▶️' },
  partnership: { envNames: ['VANTA_EMOJI_PARTNERSHIP'], id: '1567301428039516303', fallback: '🤝' },
  giveaways: { envNames: ['VANTA_EMOJI_GIVEAWAYS'], id: '1567301426722639882', fallback: '🎉' },
  chat: { envNames: ['VANTA_EMOJI_CHAT'], id: '1567301424990392370', fallback: '💬' },
  currency: { envNames: ['VANTA_EMOJI_CURRENCY'], id: '1567301423144771675', fallback: '💱' },
  gift: { envNames: ['VANTA_EMOJI_GIFT'], id: '1567301420414406826', fallback: '🎁' },
  trophy: { envNames: ['VANTA_EMOJI_TROPHY'], id: '1567301418723971192', fallback: '🏆' },
  staff: { envNames: ['VANTA_EMOJI_STAFF'], id: '1567301417452970115', fallback: '🛡️' },
  download: { envNames: ['VANTA_EMOJI_DOWNLOAD'], id: '1567301415653736609', fallback: '⬇️' },
  money: { envNames: ['VANTA_EMOJI_MONEY'], id: '1567301414001184899', fallback: '💵' },
  creditCard: { envNames: ['VANTA_EMOJI_CREDIT_CARD'], id: '1567301412608806973', fallback: '💳' },
  ticket: { envNames: ['VANTA_EMOJI_TICKET'], id: '1567301410549276672', fallback: '🎟️' },
  cart: { envNames: ['VANTA_EMOJI_CART'], id: '1558796870342545549', fallback: '🛒' },
  ticketOld: { envNames: ['VANTA_EMOJI_TICKET_OLD'], id: '1558631252792184935', fallback: '🎫' },
  announcements: { envNames: ['VANTA_EMOJI_ANNOUNCEMENTS'], id: '1558796874423468103', fallback: '📢' },
  user: { envNames: ['VANTA_EMOJI_USER'], id: '1558796866332655646', fallback: '👤' },
  calendar: { envNames: ['VANTA_EMOJI_CALENDAR'], id: '1558796867637092392', fallback: '📅' },
  boosts: { envNames: ['VANTA_EMOJI_BOOSTS'], id: '1558796857809969173', fallback: '🚀' },
  support: { envNames: ['VANTA_EMOJI_SUPPORT'], id: '1566790829614436443', fallback: '🛟' },
  pix: { envNames: ['VANTA_EMOJI_PIX'], id: '1566947593580187688', fallback: '▦' },
  payment: { envNames: ['VANTA_EMOJI_PAYMENT'], id: '1566947600786129066', fallback: '💳' },
  product: { envNames: ['VANTA_EMOJI_PRODUCT'], id: '1566790840112779325', fallback: '📦' },
  coupon: { envNames: ['VANTA_EMOJI_COUPON'], id: '1566790847851143238', fallback: '🏷️' },
  analytics: { envNames: ['VANTA_EMOJI_ANALYTICS'], id: '1566790849730318376', fallback: '📊' },
  health: { envNames: ['VANTA_EMOJI_HEALTH'], id: '1566947604653285506', fallback: '♥️' },
  settings: { envNames: ['VANTA_EMOJI_SETTINGS'], id: '1566790836727971940', fallback: '⚙️' },
  feedback: { envNames: ['VANTA_EMOJI_FEEDBACK'], id: '1566790841488379964', fallback: '⭐' },
  missions: { envNames: ['VANTA_EMOJI_MISSIONS'], id: '1566790851018100826', fallback: '🎯' },
  shield: { envNames: ['VANTA_EMOJI_SHIELD'], id: '1566947581810974740', fallback: '🛡️' },
  bell: { envNames: ['VANTA_EMOJI_BELL'], id: '1566790838799962163', fallback: '🔔' },
  cartLegacy: { envNames: ['VANTA_EMOJI_CART_LEGACY'], id: '1566790843141062836', fallback: '🛒' },
  ticketLegacy: { envNames: ['VANTA_EMOJI_TICKET_LEGACY'], id: '1566790844608946288', fallback: '🎟️' },
  announcementsLegacy: { envNames: ['VANTA_EMOJI_ANNOUNCEMENTS_LEGACY'], id: '1566947587372753027', fallback: '📢' },
  userLegacy: { envNames: ['VANTA_EMOJI_USER_LEGACY'], id: '1566790846173548574', fallback: '👤' },
  calendarLegacy: { envNames: ['VANTA_EMOJI_CALENDAR_LEGACY'], id: '1566790834953658419', fallback: '📅' },
  moneyLegacy: { envNames: ['VANTA_EMOJI_MONEY_LEGACY'], id: '1566947590396968982', fallback: '💵' },
  spotifyLegacy: { envNames: ['VANTA_EMOJI_SPOTIFY_LEGACY', 'VANTA_EMOJI_SPOTIFY'], id: '1566947595581132903', fallback: '🎵' },
  youtubeLegacy: { envNames: ['VANTA_EMOJI_YOUTUBE_LEGACY', 'VANTA_EMOJI_YOUTUBE'], id: '1566947598684917830', fallback: '▶️' },
  robuxLegacy: { envNames: ['VANTA_EMOJI_ROBUX_LEGACY'], id: '1566947585095110656', fallback: '🪙' },
  nitroLegacy: { envNames: ['VANTA_EMOJI_NITRO_LEGACY', 'VANTA_EMOJI_NITRO'], id: '1566947608004657152', fallback: '✨' },
  discordAccountsLegacy: { envNames: ['VANTA_EMOJI_DISCORD_ACCOUNTS_LEGACY', 'VANTA_EMOJI_DISCORD_ACCOUNTS'], id: '1566947601939570689', fallback: '💬' },
  boostsLegacy: { envNames: ['VANTA_EMOJI_BOOSTS_LEGACY'], id: '1566947588819652748', fallback: '🚀' },
  gamepassLegacy: { envNames: ['VANTA_EMOJI_GAMEPASS_LEGACY', 'VANTA_EMOJI_GAMEPASS'], id: '1566790852267872307', fallback: '🎮' },
});

const emojiFallbacks = Object.freeze(Object.fromEntries(
  Object.entries(emojiSettings).map(([purpose, settings]) => [purpose, settings.fallback]),
));

const available = new Map();
let unavailable = [];

export async function loadApplicationEmojis(client, env = process.env) {
  await client.application.fetch();
  const applicationEmojis = await client.application.emojis.fetch();
  available.clear();
  unavailable = [];

  for (const [purpose, settings] of Object.entries(emojiSettings)) {
    const configuredValue = settings.envNames.map((name) => env[name]?.trim())
      .find(Boolean) || settings.id;
    const emoji = /^\d{17,20}$/.test(configuredValue)
      ? applicationEmojis.get(configuredValue) ?? client.emojis?.cache?.get(configuredValue)
      : applicationEmojis.find((entry) => entry.name === configuredValue);
    if (emoji) {
      available.set(purpose, emoji);
    } else {
      unavailable.push(purpose);
    }
  }

  if (unavailable.length) {
    console.warn(`Emojis VANTA indisponíveis; usando fallback visual: ${unavailable.join(', ')}.`);
  }

  return available.size;
}

export function getApplicationEmoji(purpose) {
  return available.get(purpose) ?? null;
}

export function emojiComponent(purpose) {
  const emoji = getApplicationEmoji(purpose);
  return emoji
    ? { id: emoji.id, name: emoji.name, animated: emoji.animated }
    : emojiFallbacks[purpose] ? { name: emojiFallbacks[purpose] } : undefined;
}

export function emojiText(purpose) {
  const emoji = getApplicationEmoji(purpose);
  return emoji ? emoji.toString() : emojiFallbacks[purpose] ?? '';
}

export function getUnavailableApplicationEmojis() {
  return [...unavailable];
}
