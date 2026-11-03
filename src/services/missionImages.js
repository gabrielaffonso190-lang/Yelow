import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const maximumImageBytes = 8 * 1024 * 1024;
const allowedImageTypes = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function isPublicAddress(address, family) {
  if (family === 4) {
    const [first, second] = address.split('.').map(Number);
    return first > 0
      && first < 224
      && first !== 10
      && first !== 127
      && !(first === 100 && second >= 64 && second <= 127)
      && !(first === 169 && second === 254)
      && !(first === 172 && second >= 16 && second <= 31)
      && !(first === 192 && (second === 0 || second === 168))
      && !(first === 198 && (second === 18 || second === 19));
  }

  if (family === 6) {
    const firstHextet = Number.parseInt(address.split(':')[0] || '0', 16);
    return firstHextet >= 0x2000
      && firstHextet <= 0x3fff
      && !address.toLowerCase().startsWith('2001:db8:');
  }

  return false;
}

async function assertPublicHost(hostname, lookupImpl) {
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookupImpl(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(({ address, family: addressFamily }) => (
    !isPublicAddress(address, addressFamily)
  ))) {
    throw new Error('O endereço da imagem não aponta exclusivamente para IPs públicos.');
  }
}

export async function validateMissionImage(rawUrl, {
  fetchImpl = fetch,
  lookupImpl = lookup,
  timeoutMs = 5_000,
} = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('A imagem da Quest deve usar um endereço HTTPS válido.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('A imagem da Quest deve usar um endereço HTTPS válido.');
  }

  await assertPublicHost(url.hostname, lookupImpl);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? 'tempo limite excedido'
      : 'endereço indisponível ou redirecionado';
    throw new Error(`Não foi possível validar a imagem da Quest: ${reason}.`);
  }
  if (!response.ok) {
    throw new Error(`A imagem da Quest não está disponível (HTTP ${response.status}).`);
  }

  const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const sizeBytes = Number(response.headers.get('content-length'));
  if (!allowedImageTypes.has(mimeType)) {
    throw new Error('A imagem deve ser PNG, JPEG, WebP, GIF ou AVIF.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maximumImageBytes) {
    throw new Error('O tamanho da imagem deve ser informado e não pode exceder 8 MB.');
  }

  return { url: url.toString(), mimeType, sizeBytes };
}
