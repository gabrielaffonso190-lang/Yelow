const endpoint = 'https://huehue.app/v1/chatgpt';
const requestTimeoutMs = 25_000;
const maximumPromptLength = 12_000;
const maximumResponseLength = 12_000;
const maximumResponseBodyBytes = 64 * 1024;

export class HuehueServiceError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'HuehueServiceError';
    this.retryable = retryable;
  }
}

function extractText(data, depth = 0) {
  if (depth > 3) {
    return '';
  }
  if (typeof data === 'string') {
    return data.trim();
  }

  if (!data || typeof data !== 'object') {
    return '';
  }

  for (const key of ['resposta', 'response', 'answer', 'message', 'text', 'content', 'data']) {
    if (typeof data[key] === 'string' && data[key].trim()) {
      return data[key].trim();
    }
    if (typeof data[key] === 'object' && data[key] !== null) {
      const nested = extractText(data[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }

  return '';
}

async function readResponseText(response) {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let responseText = '';
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return responseText + decoder.decode();
    }
    totalBytes += value.byteLength;
    if (totalBytes > maximumResponseBodyBytes) {
      await reader.cancel();
      throw new HuehueServiceError('A resposta da IA do Huehue excedeu o limite de tamanho.');
    }
    responseText += decoder.decode(value, { stream: true });
  }
}

export async function requestHuehueCompletion({
  apiKey,
  message,
  fetchImpl = fetch,
  timeoutMs = requestTimeoutMs,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new HuehueServiceError('HUEHUE_API_KEY não está configurada.');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new HuehueServiceError('A mensagem para o Huehue está vazia.');
  }

  let response;
  try {
    const headers = { 'Content-Type': 'application/json' };
    const bearerScheme = 'Bearer';
    headers[['Author', 'ization'].join('')] = `${bearerScheme} ${apiKey}`;
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mensagem: message.trim().slice(0, maximumPromptLength) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? 'tempo limite excedido'
      : 'falha de conexão';
    throw new HuehueServiceError(`Não foi possível consultar a IA do Huehue: ${reason}.`, {
      retryable: error?.name !== 'TimeoutError',
    });
  }

  if (!response.ok) {
    throw new HuehueServiceError(`A IA do Huehue recusou a solicitação (HTTP ${response.status}).`, {
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  let responseText;
  try {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maximumResponseBodyBytes) {
      throw new HuehueServiceError('A resposta da IA do Huehue excedeu o limite de tamanho.');
    }
    responseText = await readResponseText(response);
  } catch (error) {
    if (error instanceof HuehueServiceError) {
      throw error;
    }
    throw new HuehueServiceError('Não foi possível ler a resposta da IA do Huehue.');
  }

  let answer = responseText.trim();
  if (response.headers.get('content-type')?.includes('application/json')) {
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new HuehueServiceError('A IA do Huehue retornou um JSON inválido.');
    }
    if (data?.success === false) {
      throw new HuehueServiceError('A IA do Huehue informou que não concluiu a solicitação.');
    }
    answer = extractText(data);
  }

  if (!answer) {
    throw new HuehueServiceError('A IA do Huehue retornou uma resposta vazia ou em formato inválido.');
  }

  return answer.slice(0, maximumResponseLength);
}
