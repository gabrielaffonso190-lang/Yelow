import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createServer } from 'node:http';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { getBannerUrl } from '../config/banners.js';
import { withTransaction, writeAuditLog } from './db.js';
import { formatMoney } from './commerce.js';

const providerAmountLimitsCents = Object.freeze({
  zpay: { minimum: 200, maximum: 200000 },
  voxpay: { minimum: 100, maximum: 100000000 },
});
const maximumWebhookBytes = 64 * 1024;
const maximumQrImageBytes = 8 * 1024 * 1024;
const webhookToleranceSeconds = 5 * 60;

export class PaymentError extends Error {
  constructor(message, { code = 'PAYMENT_ERROR', outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function amountToCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new PaymentError('O provedor retornou um valor inválido.', { code: 'INVALID_AMOUNT' });
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 1e-6) {
    throw new PaymentError('O provedor retornou um valor fora do limite.', { code: 'INVALID_AMOUNT' });
  }
  return cents;
}

function normalizeStatus(status) {
  if (typeof status !== 'string') {
    throw new PaymentError('O provedor retornou um status inválido.', { code: 'INVALID_STATUS' });
  }
  const normalized = status.toLowerCase();
  if (normalized === 'approved') return 'paid';
  if (['pending', 'paid', 'expired', 'failed', 'cancelled', 'refunded'].includes(normalized)) {
    return normalized;
  }
  return 'pending';
}

function configuredProviders(providerOrder, providers) {
  return providerOrder.filter((name) => providers[name]);
}

function paymentByOrder(db, orderId) {
  return db.prepare(`
    SELECT * FROM payments WHERE order_id = ?
    ORDER BY CASE status WHEN 'paid' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      created_at DESC LIMIT 1
  `).get(orderId);
}

function persistProviderState(db, paymentId, providerPayment) {
  if (!providerPayment || typeof providerPayment !== 'object'
    || typeof providerPayment.paymentId !== 'string' || !providerPayment.paymentId.trim()) {
    throw new PaymentError('O provedor retornou dados de cobrança inválidos.', {
      code: 'INVALID_RESPONSE',
      outcomeUnknown: true,
    });
  }

  const status = normalizeStatus(providerPayment.status);
  const amountCents = amountToCents(providerPayment.amount);
  const payment = db.prepare(`
    SELECT amount_cents, order_id, provider, environment FROM payments WHERE id = ?
  `)
    .get(paymentId);
  if (!payment || payment.amount_cents !== amountCents) {
    const error = new PaymentError('O valor confirmado pelo provedor não corresponde ao pedido.', {
      code: 'AMOUNT_MISMATCH',
      outcomeUnknown: true,
    });
    error.providerPaymentId = providerPayment.paymentId;
    throw error;
  }

  const qrCodeDataUrl = typeof providerPayment.qrCodeBase64 === 'string'
    && providerPayment.qrCodeBase64.length <= maximumQrImageBytes * 1.4
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(providerPayment.qrCodeBase64)
    ? providerPayment.qrCodeBase64
    : null;
  const copyPaste = typeof providerPayment.copyPaste === 'string'
    ? providerPayment.copyPaste.slice(0, 10000)
    : null;
  const expiresAt = typeof providerPayment.expiresAt === 'string'
    && Number.isFinite(Date.parse(providerPayment.expiresAt))
    ? providerPayment.expiresAt
    : null;
  const paidAt = status === 'paid' && typeof providerPayment.paidAt === 'string'
    && Number.isFinite(Date.parse(providerPayment.paidAt))
    ? providerPayment.paidAt
    : status === 'paid' ? new Date().toISOString() : null;
  const providerFeeCents = Number.isSafeInteger(providerPayment.feeCents)
    && providerPayment.feeCents >= 0
    ? providerPayment.feeCents
    : null;

  let queuedWebhookConfirmed = false;
  withTransaction(db, () => {
    db.prepare(`
      UPDATE payments SET provider_payment_id = ?, status = ?, copy_paste = ?,
        qr_code_data_url = ?, expires_at = ?, payment_method = ?, updated_at = ?,
        paid_at = ?, provider_fee_cents = ?
      WHERE id = ?
    `).run(
      providerPayment.paymentId,
      status,
      copyPaste,
      qrCodeDataUrl,
      expiresAt,
      typeof providerPayment.paymentMethod === 'string'
        ? providerPayment.paymentMethod.slice(0, 50)
        : 'pix',
      new Date().toISOString(),
      paidAt,
      providerFeeCents,
      paymentId,
    );
    const queuedEvents = db.prepare(`
      SELECT paid_at FROM payment_webhook_events
      WHERE provider = ? AND payment_id IS NULL
        AND external_payment_id = ? AND amount_cents = ?
    `).all(payment.provider, providerPayment.paymentId, amountCents);
    if (queuedEvents.length) {
      db.prepare(`
        UPDATE payment_webhook_events SET payment_id = ?
        WHERE provider = ? AND payment_id IS NULL
          AND external_payment_id = ? AND amount_cents = ?
      `).run(paymentId, payment.provider, providerPayment.paymentId, amountCents);
      queuedWebhookConfirmed = true;
      if (status !== 'paid') {
        const webhookPaidAt = queuedEvents[0].paid_at || new Date().toISOString();
        db.prepare(`
          UPDATE payments SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?
        `).run(webhookPaidAt, new Date().toISOString(), paymentId);
        writeAuditLog(db, db.prepare('SELECT guild_id FROM orders WHERE id = ?')
          .get(payment.order_id).guild_id, `system:${payment.provider}`, 'payment.confirmed', {
          orderId: payment.order_id,
          provider: payment.provider,
          providerPaymentId: providerPayment.paymentId,
          amountCents,
          source: 'webhook',
        });
      }
    }
    if (status === 'paid' && !queuedWebhookConfirmed) {
      writeAuditLog(db, db.prepare('SELECT guild_id FROM orders WHERE id = ?')
        .get(payment.order_id).guild_id,
      `system:${payment.provider}`,
      payment.environment === 'sandbox' ? 'payment.sandbox_status' : 'payment.confirmed',
      {
        orderId: payment.order_id,
        provider: payment.provider,
        environment: payment.environment,
        providerPaymentId: providerPayment.paymentId,
        amountCents,
      });
    }
  });

  return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}

function createAttempt(db, order, providerName, environment) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const idempotencyKey = `vanta-${order.id}`;
  db.prepare(`
    INSERT INTO payments
      (id, order_id, provider, idempotency_key, amount_cents, environment,
       status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?)
  `).run(id, order.id, providerName, idempotencyKey, order.total_cents, environment, now, now);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

export async function createOrderPayment({
  db,
  orderId,
  payerName,
  providers,
  providerOrder,
}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new PaymentError('Pedido não encontrado.', { code: 'ORDER_NOT_FOUND' });
  if (order.status === 'cancelled') {
    throw new PaymentError('Não é possível cobrar um pedido cancelado.', { code: 'ORDER_CANCELLED' });
  }

  const configured = configuredProviders(providerOrder, providers);
  const environment = providers[configured[0]]?.environment || 'production';
  const candidates = configured.filter((providerName) => {
    const limits = providerAmountLimitsCents[providerName];
    return (providers[providerName].environment || 'production') === environment
      && limits
      && Number.isSafeInteger(order.total_cents)
      && order.total_cents >= limits.minimum
      && order.total_cents <= limits.maximum;
  });
  const existing = paymentByOrder(db, orderId);
  if (existing && existing.environment !== environment) {
    throw new PaymentError(
      'O pedido já possui cobrança em outro ambiente. Não misture Sandbox e produção.',
      { code: 'ENVIRONMENT_MISMATCH' },
    );
  }
  if (existing?.status === 'paid' || existing?.status === 'pending') return existing;
  if (existing && ['creating', 'outcome_unknown'].includes(existing.status)) {
    throw new PaymentError(
      'O resultado da cobrança anterior é incerto. Não tente gerar outra; consulte a equipe.',
      { code: 'OUTCOME_UNKNOWN', outcomeUnknown: true },
    );
  }
  if (!candidates.length) {
    if (configured.length) {
      throw new PaymentError(
        'O valor deste pedido está fora dos limites Pix dos provedores configurados.',
        { code: 'AMOUNT_OUT_OF_RANGE' },
      );
    }
    throw new PaymentError('Nenhum provedor de pagamento está configurado.', {
      code: 'PROVIDER_UNAVAILABLE',
    });
  }

  let lastAuthError;
  for (const providerName of candidates) {
    let previousAttempt = db.prepare(
      'SELECT * FROM payments WHERE order_id = ? AND provider = ?',
    ).get(orderId, providerName);
    if (previousAttempt) {
      if (previousAttempt.status === 'paid' || previousAttempt.status === 'pending') {
        return previousAttempt;
      }
      if (['creating', 'outcome_unknown'].includes(previousAttempt.status)) {
        throw new PaymentError(
          'O resultado de uma tentativa anterior é incerto. Não tente gerar outra cobrança.',
          { code: 'OUTCOME_UNKNOWN', outcomeUnknown: true },
        );
      }
      if (previousAttempt.status !== 'failed' || previousAttempt.last_http_status !== 401) {
        continue;
      }
      db.prepare(`
        UPDATE payments SET status = 'creating', last_error_code = NULL,
          last_http_status = NULL, updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), previousAttempt.id);
      previousAttempt = db.prepare('SELECT * FROM payments WHERE id = ?')
        .get(previousAttempt.id);
    }

    const attempt = previousAttempt || createAttempt(
      db,
      order,
      providerName,
      providers[providerName].environment || 'production',
    );
    let providerPayment;
    try {
      providerPayment = await providers[providerName].createPayment({
        amount: order.total_cents / 100,
        payerName: String(payerName || 'Cliente').trim().slice(0, 100) || 'Cliente',
        description: `Pedido ${order.id}`,
        idempotencyKey: attempt.idempotency_key,
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 0;
      const code = typeof error?.code === 'string' ? error.code.slice(0, 100) : 'PROVIDER_ERROR';
      const definitiveUnavailable = status === 401
        || status === 403
        || ['provider_auth_failed', 'provider_not_configured', 'provider_route_not_found']
          .includes(code);
      const unknown = error?.outcomeUnknown === true
        || (!definitiveUnavailable && (
          status === 0
          || status >= 500
          || status === 408
          || status === 429
        ));
      const nextState = unknown ? 'outcome_unknown' : 'failed';
      db.prepare(`
        UPDATE payments SET status = ?, last_error_code = ?, last_http_status = ?,
          provider_payment_id = COALESCE(?, provider_payment_id), updated_at = ?
        WHERE id = ?
      `).run(
        nextState,
        code,
        status || null,
        typeof error?.providerPaymentId === 'string' ? error.providerPaymentId : null,
        new Date().toISOString(),
        attempt.id,
      );
      writeAuditLog(db, order.guild_id, `system:${providerName}`, 'payment.provider_error', {
        orderId: order.id,
        provider: providerName,
        code,
        httpStatus: status || null,
        outcomeUnknown: unknown,
      });

      if (unknown) {
        throw new PaymentError(
          'A resposta do provedor não confirmou o resultado. Consulte a cobrança antes de tentar novamente.',
          { code, outcomeUnknown: true },
        );
      }
      if (definitiveUnavailable) {
        lastAuthError = code;
        continue;
      }
      throw new PaymentError(
        'O provedor recusou a cobrança. O pedido continua aberto para análise da equipe.',
        { code },
      );
    }
    try {
      return persistProviderState(db, attempt.id, providerPayment);
    } catch (error) {
      if (!(error instanceof PaymentError) || !error.outcomeUnknown) throw error;
      db.prepare(`
        UPDATE payments SET status = 'outcome_unknown', last_error_code = ?,
          provider_payment_id = COALESCE(?, provider_payment_id), updated_at = ?
        WHERE id = ?
      `).run(
        error.code,
        typeof error.providerPaymentId === 'string' ? error.providerPaymentId : null,
        new Date().toISOString(),
        attempt.id,
      );
      writeAuditLog(db, order.guild_id, `system:${providerName}`, 'payment.provider_error', {
        orderId: order.id,
        provider: providerName,
        code: error.code,
        outcomeUnknown: true,
      });
      throw error;
    }
  }

  throw new PaymentError(
    lastAuthError
      ? 'Os provedores configurados recusaram a autenticação ou não estão habilitados.'
      : 'Nenhum provedor de pagamento está disponível.',
    { code: lastAuthError || 'PROVIDER_UNAVAILABLE' },
  );
}

export async function refreshOrderPayment({ db, orderId, providers }) {
  const payment = paymentByOrder(db, orderId);
  if (!payment) throw new PaymentError('Este pedido ainda não tem cobrança.', { code: 'PAYMENT_NOT_FOUND' });
  if (!['pending', 'paid', 'outcome_unknown'].includes(payment.status)) return payment;

  const provider = providers[payment.provider];
  if (!provider || !payment.provider_payment_id) {
    throw new PaymentError('Não foi possível consultar a cobrança neste momento.', {
      code: payment.status === 'outcome_unknown' ? 'OUTCOME_UNKNOWN' : 'PROVIDER_UNAVAILABLE',
      outcomeUnknown: payment.status === 'outcome_unknown',
    });
  }
  try {
    const current = await provider.getPayment(payment.provider_payment_id);
    return persistProviderState(db, payment.id, current);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 0;
    const code = typeof error?.code === 'string' ? error.code.slice(0, 100) : 'PROVIDER_ERROR';
    const order = db.prepare('SELECT guild_id FROM orders WHERE id = ?').get(orderId);
    writeAuditLog(db, order.guild_id, `system:${payment.provider}`, 'payment.provider_error', {
      orderId,
      provider: payment.provider,
      code,
      httpStatus: status || null,
      operation: 'status_lookup',
    });
    throw new PaymentError('Não foi possível consultar a cobrança no provedor.', { code });
  }
}

function parseSignature(signature) {
  if (typeof signature !== 'string') return null;
  const value = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[a-zA-Z0-9+/]{43}=$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  }
  return null;
}

export function verifyZpayWebhook({ rawBody, timestamp, signature, secret, now = Date.now() }) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof timestamp !== 'string'
    || !/^\d{10}$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (Math.abs(Math.floor(now / 1000) - timestampSeconds) > webhookToleranceSeconds) return false;
  const supplied = parseSignature(signature);
  if (!supplied) return false;
  const expected = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function handleZpayWebhook({ db, rawBody, headers, secret }) {
  const timestamp = headers['x-zpay-timestamp'];
  const signature = headers['x-zpay-signature'];
  if (!verifyZpayWebhook({ rawBody, timestamp, signature, secret })) {
    throw new PaymentError('Assinatura do webhook inválida ou expirada.', { code: 'INVALID_SIGNATURE' });
  }

  const sandboxHeader = headers['x-zpay-sandbox'];
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new PaymentError('Corpo de webhook inválido.', { code: 'INVALID_WEBHOOK' });
  }
  if (sandboxHeader === '1' || event.livemode === false
    || (typeof event.event === 'string' && event.event.startsWith('sandbox.'))) {
    throw new PaymentError('Webhooks de Sandbox não são aceitos em produção.', {
      code: 'SANDBOX_REJECTED',
    });
  }
  if (event.event !== 'payment.paid' || event.data?.status !== 'paid') {
    throw new PaymentError('Evento de pagamento não reconhecido.', { code: 'UNSUPPORTED_EVENT' });
  }
  const providerPaymentId = event.data.id || event.data.paymentId;
  if (typeof providerPaymentId !== 'string' || !providerPaymentId) {
    throw new PaymentError('Evento sem identificador de cobrança.', { code: 'INVALID_WEBHOOK' });
  }
  const amountCents = amountToCents(event.data.amount);
  const payment = db.prepare(`
    SELECT * FROM payments
    WHERE provider = 'zpay' AND environment = 'production' AND provider_payment_id = ?
  `).get(providerPaymentId);
  if (payment && payment.amount_cents !== amountCents) {
    throw new PaymentError('Pagamento não localizado ou valor incompatível.', {
      code: 'PAYMENT_MISMATCH',
    });
  }

  const eventHash = createHash('sha256').update(rawBody).digest('hex');
  const paidAt = typeof event.data.paidAt === 'string'
    && Number.isFinite(Date.parse(event.data.paidAt))
    ? event.data.paidAt
    : new Date().toISOString();
  const inserted = withTransaction(db, () => {
    const result = db.prepare(`
      INSERT OR IGNORE INTO payment_webhook_events
          (event_hash, provider, payment_id, external_payment_id, amount_cents,
            paid_at, event_type, received_at, delivery_id)
        VALUES (?, 'zpay', ?, ?, ?, ?, 'payment.paid', ?, NULL)
      `).run(
        eventHash,
        payment?.id ?? null,
        providerPaymentId,
        amountCents,
        paidAt,
        new Date().toISOString(),
      );
      if (!result.changes) return false;

      if (payment) {
        db.prepare(`
          UPDATE payments SET status = 'paid', paid_at = ?, updated_at = ?
          WHERE id = ? AND status != 'paid'
        `).run(paidAt, new Date().toISOString(), payment.id);
        if (payment.status !== 'paid') {
          const order = db.prepare('SELECT guild_id FROM orders WHERE id = ?').get(payment.order_id);
          writeAuditLog(db, order.guild_id, 'system:zpay', 'payment.confirmed', {
            orderId: payment.order_id,
            provider: 'zpay',
            providerPaymentId,
            amountCents,
            source: 'webhook',
          });
        }
      }
      return true;
  });

  return { duplicate: !inserted, paymentId: payment?.id ?? null, queued: !payment && inserted };
}

export function verifyVoxPayWebhook({ rawBody, signature, secret, timestamp, now = Date.now() }) {
  if (!Buffer.isBuffer(rawBody) || !secret
    || typeof timestamp !== 'string'
    || !/^\d{10}$/.test(timestamp)
    || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > webhookToleranceSeconds) {
    return false;
  }
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature ?? '');
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(match[1], 'hex');
  return timingSafeEqual(expected, supplied);
}

export function handleVoxPayWebhook({ db, rawBody, headers, secret }) {
  const eventName = headers['x-voxpay-event'];
  const deliveryId = headers['x-voxpay-delivery'];
  const timestamp = headers['x-voxpay-timestamp'];
  if (!verifyVoxPayWebhook({
    rawBody,
    signature: headers['x-voxpay-signature'],
    secret,
    timestamp,
  })) {
    throw new PaymentError('Assinatura do webhook VoxPay inválida ou expirada.', {
      code: 'INVALID_SIGNATURE',
    });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new PaymentError('Corpo de webhook VoxPay inválido.', { code: 'INVALID_WEBHOOK' });
  }
  if (typeof eventName !== 'string' || eventName !== 'payment.approved'
    || event.event !== 'payment.approved' || event.data?.status !== 'approved'
    || typeof deliveryId !== 'string' || !deliveryId.trim() || deliveryId.length > 200) {
    throw new PaymentError('Evento de pagamento VoxPay não reconhecido.', {
      code: 'UNSUPPORTED_EVENT',
    });
  }
  const providerPaymentId = event.data.id;
  const amountCents = event.data.amount_cents;
  if (typeof providerPaymentId !== 'string' || !providerPaymentId
    || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new PaymentError('Evento sem identificador ou valor de cobrança válido.', {
      code: 'INVALID_WEBHOOK',
    });
  }
  const payment = db.prepare(`
    SELECT * FROM payments WHERE provider = 'voxpay' AND provider_payment_id = ?
  `).get(providerPaymentId);
  if (payment && payment.amount_cents !== amountCents) {
    throw new PaymentError('Valor do evento não corresponde ao pedido.', {
      code: 'PAYMENT_MISMATCH',
    });
  }

  const deliveryHash = createHash('sha256').update(rawBody).digest('hex');
  const approvedAt = typeof event.data.approved_at === 'string'
    && Number.isFinite(Date.parse(event.data.approved_at))
    ? event.data.approved_at
    : typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt))
      ? event.createdAt
      : new Date().toISOString();
  const inserted = withTransaction(db, () => {
    const result = db.prepare(`
      INSERT OR IGNORE INTO payment_webhook_events
        (event_hash, provider, payment_id, external_payment_id, amount_cents,
          paid_at, event_type, received_at, delivery_id)
      VALUES (?, 'voxpay', ?, ?, ?, ?, 'payment.approved', ?, ?)
    `).run(
      deliveryHash,
      payment?.id ?? null,
      providerPaymentId,
      amountCents,
      approvedAt,
      new Date().toISOString(),
      deliveryId,
    );
    if (!result.changes) return false;
    if (payment) {
      db.prepare(`
        UPDATE payments SET status = 'paid', paid_at = ?, updated_at = ?,
          provider_fee_cents = ?
        WHERE id = ? AND status != 'paid'
      `).run(
        approvedAt,
        new Date().toISOString(),
        Number.isSafeInteger(event.data.platform_fee_cents)
          ? event.data.platform_fee_cents
          : null,
        payment.id,
      );
      if (payment.status !== 'paid') {
        const order = db.prepare('SELECT guild_id FROM orders WHERE id = ?').get(payment.order_id);
        writeAuditLog(db, order.guild_id, 'system:voxpay', 'payment.confirmed', {
          orderId: payment.order_id,
          provider: 'voxpay',
          providerPaymentId,
          amountCents,
          source: 'webhook',
        });
      }
    }
    return true;
  });
  return { duplicate: !inserted, paymentId: payment?.id ?? null, queued: !payment && inserted };
}

export function startPaymentWebhookServer({
  db,
  secret,
  voxpaySecret,
  port = 8787,
  host = '0.0.0.0',
}) {
  if (!secret && !voxpaySecret) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('ZPAY_WEBHOOK_PORT must be a valid TCP port.');
  }

  const server = createServer((request, response) => {
    if (request.method !== 'POST'
      || !['/webhooks/zpay', '/webhooks/voxpay'].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }

    let size = 0;
    let oversized = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumWebhookBytes && !oversized) {
        oversized = true;
        chunks.length = 0;
        response.writeHead(413).end();
        return;
      }
      if (!oversized) chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) return;
      try {
        const isVoxPay = request.url === '/webhooks/voxpay';
        const webhookHandler = isVoxPay ? handleVoxPayWebhook : handleZpayWebhook;
        webhookHandler({
          db,
          rawBody: Buffer.concat(chunks),
          headers: request.headers,
          secret: isVoxPay ? voxpaySecret : secret,
        });
        response.writeHead(200).end();
      } catch (error) {
        const code = error instanceof PaymentError ? error.code : 'WEBHOOK_ERROR';
        const providerName = request.url === '/webhooks/voxpay' ? 'VoxPay' : 'Z.PAY';
        console.error(`Webhook ${providerName} rejeitado (${code}).`);
        const status = error?.code === 'INVALID_SIGNATURE' ? 401
          : error?.code === 'PAYMENT_MISMATCH' ? 404 : 400;
        response.writeHead(status).end();
      }
    });
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(port, host);
  return server;
}

export const startZpayWebhookServer = startPaymentWebhookServer;

export function buildPixMessage(payment, order, db = null, {
  localExpiresAt = null,
  includePaymentRefresh = true,
} = {}) {
  const isSandbox = payment.environment === 'sandbox';
  const embed = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle(isSandbox ? 'Pagamento Pix · SANDBOX' : 'Pagamento Pix')
    .setDescription([
      `Pedido: \`${order.id}\``,
      `Identificador da cobrança: \`${payment.provider_payment_id || payment.id}\``,
      payment.created_at ? `Criada em: <t:${Math.floor(Date.parse(payment.created_at) / 1000)}:F>` : null,
      `Valor: **${formatMoney(payment.amount_cents)}**`,
      `Status: **${payment.status}**`,
      payment.expires_at ? `Validade: <t:${Math.floor(Date.parse(payment.expires_at) / 1000)}:F>` : null,
      localExpiresAt ? `Prazo local: <t:${Math.floor(Date.parse(localExpiresAt) / 1000)}:F> (não altera a validade no provedor).` : null,
      isSandbox ? '**Teste fictício: não representa pagamento real e não libera entrega.**' : null,
    ].filter(Boolean).join('\n')));
  const files = [];
  const paymentBanner = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.surface)
    .setTitle('VANTA | Pagamentos')
    .setImage(getBannerUrl(db, order.guild_id, 'payments')));
  const rows = includePaymentRefresh
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`order:payment:${order.id}`)
        .setLabel('Verificar pagamento')
        .setStyle(ButtonStyle.Secondary),
    )]
    : [];

  if (payment.copy_paste) {
    const pixCode = payment.copy_paste.replace(/[\r\n`]/g, '').slice(0, 1000);
    embed.addFields({ name: 'Pix copia e cola', value: `\`\`\`\n${pixCode}\n\`\`\`` });
  }
  if (payment.qr_code_data_url) {
    const match = payment.qr_code_data_url.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$/);
    if (match) {
      const image = Buffer.from(match[2], 'base64');
      if (image.length > maximumQrImageBytes) {
        return { embeds: [embed, paymentBanner], components: rows, files };
      }
      const extension = match[1] === 'jpeg' ? 'jpg' : 'png';
      const filename = `pix-${order.id}.${extension}`;
      files.push(new AttachmentBuilder(image, { name: filename }));
      embed.setImage(`attachment://${filename}`);
    }
  }

  return { embeds: [embed, paymentBanner], components: rows, files };
}
