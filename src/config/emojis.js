const emojiSettings = Object.freeze({
  success: 'VANTA_EMOJI_SUCCESS',
  error: 'VANTA_EMOJI_ERROR',
  warning: 'VANTA_EMOJI_WARNING',
  loading: 'VANTA_EMOJI_LOADING',
  cart: 'VANTA_EMOJI_CART',
  ticket: 'VANTA_EMOJI_TICKET',
  support: 'VANTA_EMOJI_SUPPORT',
  pix: 'VANTA_EMOJI_PIX',
  payment: 'VANTA_EMOJI_PAYMENT',
  product: 'VANTA_EMOJI_PRODUCT',
  coupon: 'VANTA_EMOJI_COUPON',
  analytics: 'VANTA_EMOJI_ANALYTICS',
  health: 'VANTA_EMOJI_HEALTH',
  settings: 'VANTA_EMOJI_SETTINGS',
  announcements: 'VANTA_EMOJI_ANNOUNCEMENTS',
  feedback: 'VANTA_EMOJI_FEEDBACK',
  user: 'VANTA_EMOJI_USER',
  calendar: 'VANTA_EMOJI_CALENDAR',
  money: 'VANTA_EMOJI_MONEY',
  missions: 'VANTA_EMOJI_MISSIONS',
  spotify: 'VANTA_EMOJI_SPOTIFY',
  youtube: 'VANTA_EMOJI_YOUTUBE',
  robux: 'VANTA_EMOJI_ROBUX',
  nitro: 'VANTA_EMOJI_NITRO',
  discordAccounts: 'VANTA_EMOJI_DISCORD_ACCOUNTS',
  boosts: 'VANTA_EMOJI_BOOSTS',
  gamepass: 'VANTA_EMOJI_GAMEPASS',
});

const available = new Map();

export async function loadApplicationEmojis(client) {
  await client.application.fetch();
  const applicationEmojis = await client.application.emojis.fetch();
  available.clear();

  for (const [purpose, envName] of Object.entries(emojiSettings)) {
    const configuredName = process.env[envName]?.trim();
    if (!configuredName) {
      continue;
    }

    const emoji = applicationEmojis.find((entry) => entry.name === configuredName);
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
