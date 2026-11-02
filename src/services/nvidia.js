const modelsEndpoint = 'https://integrate.api.nvidia.com/v1/models';
const knownModels = new Set(['z-ai/glm-5.3', 'z-ai/glm-5.3-flash']);
const cacheDurationMs = 60_000;

let cachedModels;
let cacheExpiresAt = 0;

export class NvidiaServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NvidiaServiceError';
  }
}

export async function getAvailableNvidiaModels({
  apiKey,
  fetchImpl = fetch,
  forceRefresh = false,
  timeoutMs = 8_000,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new NvidiaServiceError('NVIDIA_API_KEY não está configurada.');
  }

  if (!forceRefresh && cachedModels && cacheExpiresAt > Date.now()) {
    return [...cachedModels];
  }

  let response;
  try {
    response = await fetchImpl(modelsEndpoint, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'tempo limite excedido' : 'falha de conexão';
    throw new NvidiaServiceError(`Não foi possível consultar os modelos NVIDIA: ${reason}.`);
  }

  if (!response.ok) {
    throw new NvidiaServiceError(`A NVIDIA recusou a consulta de modelos (HTTP ${response.status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new NvidiaServiceError('A NVIDIA retornou uma lista de modelos inválida.');
  }

  if (!Array.isArray(data?.data)) {
    throw new NvidiaServiceError('A resposta de modelos da NVIDIA não tem o formato esperado.');
  }

  const models = [...new Set(data.data
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string' && knownModels.has(id)))];
  cachedModels = models;
  cacheExpiresAt = Date.now() + cacheDurationMs;
  return [...models];
}

export async function resolveAvailableNvidiaModel(preferredModel, apiKey, options) {
  if (!knownModels.has(preferredModel)) {
    throw new NvidiaServiceError('O modelo configurado para a IA não é permitido.');
  }

  const availableModels = await getAvailableNvidiaModels({ ...options, apiKey });
  if (availableModels.includes(preferredModel)) {
    return preferredModel;
  }

  if (availableModels.includes('z-ai/glm-5.3-flash')) {
    return 'z-ai/glm-5.3-flash';
  }

  throw new NvidiaServiceError(
    'Nenhum dos modelos GLM compatíveis está disponível para esta conta NVIDIA.',
  );
}

export function clearNvidiaModelCache() {
  cachedModels = undefined;
  cacheExpiresAt = 0;
}
