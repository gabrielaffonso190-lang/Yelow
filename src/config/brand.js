export const BRAND = Object.freeze({
  name: 'VANTA',
  signature: 'Vanta - 2027',
  slogan: 'Technology without limits.',
  colors: Object.freeze({
    black: 0x090909,
    white: 0xffffff,
    surface: 0x151515,
    surfaceSecondary: 0x202020,
    gray: 0xa0a0a0,
    border: 0x303030,
  }),
});

export function withBrandSignature(embed) {
  const current = embed.data.footer?.text;
  embed.setFooter({
    text: current ? `${current} · ${BRAND.signature}` : BRAND.signature,
  });
  return embed;
}
