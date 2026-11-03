const emojiSettings = Object.freeze({
  success: ['VANTA_EMOJI_SUCCESS', '1566947592229748756'],
  error: ['VANTA_EMOJI_ERROR', '1566947606196654120'],
  warning: ['VANTA_EMOJI_WARNING', '1566947583593681077'],
  loading: ['VANTA_EMOJI_LOADING', '1566790827529998407'],
  cart: ['VANTA_EMOJI_CART', '1566790843141062836'],
  ticket: ['VANTA_EMOJI_TICKET', '1566790844608946288'],
  support: ['VANTA_EMOJI_SUPPORT', '1566790829614436443'],
  pix: ['VANTA_EMOJI_PIX', '1566947593580187688'],
  payment: ['VANTA_EMOJI_PAYMENT', '1566947600786129066'],
  product: ['VANTA_EMOJI_PRODUCT', '1566790840112779325'],
  coupon: ['VANTA_EMOJI_COUPON', '1566790847851143238'],
  analytics: ['VANTA_EMOJI_ANALYTICS', '1566790849730318376'],
  health: ['VANTA_EMOJI_HEALTH', '1566947604653285506'],
  settings: ['VANTA_EMOJI_SETTINGS', '1566790836727971940'],
  announcements: ['VANTA_EMOJI_ANNOUNCEMENTS', '1566947587372753027'],
  feedback: ['VANTA_EMOJI_FEEDBACK', '1566790841488379964'],
  user: ['VANTA_EMOJI_USER', '1566790846173548574'],
  calendar: ['VANTA_EMOJI_CALENDAR', '1566790834953658419'],
  money: ['VANTA_EMOJI_MONEY', '1566947590396968982'],
  missions: ['VANTA_EMOJI_MISSIONS', '1566790851018100826'],
  spotify: ['VANTA_EMOJI_SPOTIFY', '1566947595581132903'],
  youtube: ['VANTA_EMOJI_YOUTUBE', '1566947598684917830'],
  robux: ['VANTA_EMOJI_ROBUX', '1566947585095110656'],
  nitro: ['VANTA_EMOJI_NITRO', '1566947608004657152'],
  discordAccounts: ['VANTA_EMOJI_DISCORD_ACCOUNTS', '1566947601939570689'],
  boosts: ['VANTA_EMOJI_BOOSTS', '1566947588819652748'],
  gamepass: ['VANTA_EMOJI_GAMEPASS', '1566790852267872307'],
  shield: ['VANTA_EMOJI_SHIELD', '1566947581810974740'],
  bell: ['VANTA_EMOJI_BELL', '1566790838799962163'],
});

const available = new Map();

export async function loadApplicationEmojis(client, env = process.env) {
  await client.application.fetch();
  const applicationEmojis = await client.application.emojis.fetch();
  available.clear();

  for (const [purpose, [envName, defaultId]] of Object.entries(emojiSettings)) {
    const configuredValue = env[envName]?.trim() || defaultId;
    const emoji = /^\d{17,20}$/.test(configuredValue)
      ? applicationEmojis.get(configuredValue)
      : applicationEmojis.find((entry) => entry.name === configuredValue);
    if (emoji) {
      available.set(purpose, emoji);
    }
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
    : undefined;
}

export function emojiText(purpose) {
  const emoji = getApplicationEmoji(purpose);
  return emoji ? emoji.toString() : '';
}
