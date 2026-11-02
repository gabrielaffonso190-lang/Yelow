import { ZPay } from '@isnouu/zpay-sdk';

const providerNames = ['zpay', 'voxpay'];
const defaultVoxPayUrl = 'https://voxpaybr.com/api/v1';
const defaultZpayUrl = 'https://zpaysolution.com/api/v1';

function getZpayBaseUrl(apiUrl, environment) {
  const url = new URL(apiUrl || defaultZpayUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('ZPAY_API_URL must be an HTTPS base URL without credentials or query parameters.');
  }
  const baseUrl = url.href.replace(/\/+$/, '');
  const isSandboxUrl = new URL(baseUrl).pathname.endsWith('/sandbox');
  if (environment === 'production' && isSandboxUrl) {
    throw new TypeError('ZPAY_API_URL points to Sandbox while ZPAY_ENVIRONMENT is production.');
  }
  if (environment === 'sandbox' && !isSandboxUrl) {
    return `${baseUrl}/sandbox`;
  }
  return baseUrl;
}

function getVoxPayBaseUrl(rawUrl) {
  const url = new URL(rawUrl || defaultVoxPayUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('VOXPAY_API_URL must be an HTTPS base URL without credentials or query parameters.');
  }
  return url.href.replace(/\/+$/, '');
}

function createVoxPayProvider({
  apiKey,
  apiUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  if (!apiKey?.trim()) return null;
  const baseUrl = getVoxPayBaseUrl(apiUrl);

  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const requestError = new Error('VoxPay request failed.');
      requestError.code = error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
      requestError.outcomeUnknown = method !== 'GET';
      throw requestError;
    }

    let payload;
    try {
      const text = await response.text();
      if (text.length > 128 * 1024) {
        throw new Error('Response too large.');
      }
      payload = text ? JSON.parse(text) : {};
    } catch {
      const responseError = new Error('VoxPay returned invalid JSON.');
      responseError.status = response.status;
      responseError.code = 'INVALID_RESPONSE';
      responseError.outcomeUnknown = method !== 'GET';
      throw responseError;
    }

    if (!response.ok) {
      const apiError = new Error('VoxPay rejected the request.');
      apiError.status = response.status;
      apiError.code = typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
      apiError.providerPaymentId = typeof payload.charge_id === 'string'
        ? payload.charge_id
        : typeof payload.data?.id === 'string' ? payload.data.id : undefined;
      const definitiveConfigurationErrors = [
        'provider_auth_failed',
        'provider_not_configured',
        'provider_route_not_found',
      ];
      apiError.outcomeUnknown = !definitiveConfigurationErrors.includes(payload.error)
        && (response.status >= 500
          || [408, 429].includes(response.status)
          || payload.error === 'provider_outcome_unknown'
          || payload.error === 'provider_timeout'
          || payload.error === 'charge_creation_in_progress');
      throw apiError;
    }

    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      const responseError = new Error('VoxPay returned an unexpected response.');
      responseError.status = response.status;
      responseError.code = 'INVALID_RESPONSE';
      responseError.outcomeUnknown = method !== 'GET';
      throw responseError;
    }
    return payload.data;
  }

  function normalizeCharge(charge) {
    if (!Number.isSafeInteger(charge.amount_cents) || charge.amount_cents <= 0) {
      const responseError = new Error('VoxPay returned an invalid charge amount.');
      responseError.code = 'INVALID_RESPONSE';
      responseError.outcomeUnknown = true;
      throw responseError;
    }
    return {
      paymentId: charge.id,
      amount: charge.amount_cents / 100,
      status: charge.status,
      copyPaste: charge.pix_copy_paste ?? null,
      qrCodeBase64: charge.pix_qr_code ?? null,
      expiresAt: charge.expires_at ?? null,
      paidAt: charge.approved_at ?? null,
      paymentMethod: charge.payment_method ?? 'pix',
      feeCents: Number.isSafeInteger(charge.platform_fee_cents)
        ? charge.platform_fee_cents
        : null,
      externalReference: charge.external_reference ?? null,
    };
  }

  return {
    async createPayment(data) {
      const charge = await request('POST', '/charges', {
        amount: data.amount,
        external_reference: data.idempotencyKey,
        description: data.description,
        payment_method: 'pix',
        customer: { name: data.payerName },
      });
      return normalizeCharge(charge);
    },
    async getPayment(paymentId) {
      const charge = await request('GET', `/charges/${encodeURIComponent(paymentId)}`);
      return normalizeCharge(charge);
    },
  };
}

export function getPaymentProviderOrder(env = process.env) {
  const primary = (env.PAYMENT_PROVIDER || 'zpay').trim().toLowerCase();
  if (!providerNames.includes(primary)) {
    throw new Error('PAYMENT_PROVIDER must be zpay or voxpay.');
  }

  return [primary, ...providerNames.filter((name) => name !== primary)];
}

export function createZpayProvider({
  clientId,
  clientSecret,
  apiUrl,
  environment = 'production',
  timeoutMs = 15000,
  Client = ZPay,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!clientId || !clientSecret) {
    return null;
  }
  if (!['production', 'sandbox'].includes(environment)) {
    throw new TypeError('ZPAY_ENVIRONMENT must be production or sandbox.');
  }

  const client = new Client({
    clientId,
    clientSecret,
    baseUrl: getZpayBaseUrl(apiUrl, environment),
    timeoutMs,
    fetch: fetchImpl,
  });

  return {
    environment,
    createPayment: (data) => client.payments.create(data),
    getPayment: (paymentId) => client.payments.get(paymentId),
    async simulatePayment(paymentId, status) {
      if (environment !== 'sandbox') {
        throw new Error('Z.PAY payment simulation is available only in Sandbox.');
      }
      if (!['paid', 'expired', 'failed'].includes(status)) {
        throw new TypeError('Sandbox status must be paid, expired, or failed.');
      }
      const baseUrl = getZpayBaseUrl(apiUrl, environment);
      const response = await fetchImpl(
        `${baseUrl}/payments/${encodeURIComponent(paymentId)}/simulate`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'client-id': clientId,
            'client-secret': clientSecret,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!response.ok) {
        const error = new Error('Z.PAY Sandbox rejected the simulation.');
        error.status = response.status;
        error.code = `HTTP_${response.status}`;
        throw error;
      }
      return client.payments.get(paymentId);
    },
  };
}

export function createPaymentProviders(env = process.env, options = {}) {
  const providers = {};
  const zpayEnvironment = env.ZPAY_ENVIRONMENT?.trim().toLowerCase() || 'production';
  if (!['production', 'sandbox'].includes(zpayEnvironment)) {
    throw new Error('ZPAY_ENVIRONMENT must be production or sandbox.');
  }
  const zpay = createZpayProvider({
    clientId: env.ZPAY_CLIENT_ID?.trim(),
    clientSecret: env.ZPAY_CLIENT_SECRET?.trim(),
    apiUrl: env.ZPAY_API_URL?.trim() || undefined,
    environment: zpayEnvironment,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    Client: options.ZpayClient,
  });
  if (zpay) {
    providers.zpay = zpay;
  }
  const configuredOrder = getPaymentProviderOrder(env);
  if (zpayEnvironment === 'sandbox') {
    if (configuredOrder[0] !== 'zpay') {
      throw new Error('ZPAY_ENVIRONMENT=sandbox requires PAYMENT_PROVIDER=zpay.');
    }
    return { providers, providerOrder: ['zpay'] };
  }

  const voxpay = createVoxPayProvider({
    apiKey: env.VOXPAY_API_KEY?.trim(),
    apiUrl: env.VOXPAY_API_URL?.trim() || undefined,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  if (voxpay) providers.voxpay = voxpay;

  return {
    providers,
    providerOrder: configuredOrder,
  };
}

export { createVoxPayProvider };
