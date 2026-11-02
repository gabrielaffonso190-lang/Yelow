import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ensurePaymentSchema } from '../src/services/db.js';
import {
  createVoxPayProvider,
  createPaymentProviders,
  createZpayProvider,
  getPaymentProviderOrder,
} from '../src/services/paymentProviders.js';
import {
  buildPixMessage,
  createOrderPayment,
  handleZpayWebhook,
  handleVoxPayWebhook,
  PaymentError,
  refreshOrderPayment,
} from '../src/services/payments.js';

function createPaymentDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, subtotal_cents INTEGER NOT NULL,
      discount_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
      coupon_code TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  ensurePaymentSchema(db);
  db.prepare(`
    INSERT INTO orders
      (id, guild_id, user_id, status, subtotal_cents, discount_cents, total_cents, created_at)
    VALUES ('order-1', 'guild-1', 'buyer-1', 'in_service', 2500, 0, 2500, ?)
  `).run(new Date().toISOString());
  return db;
}

function providerPayment(overrides = {}) {
  return {
    paymentId: 'zpay-payment-1',
    amount: 25,
    status: 'pending',
    copyPaste: 'pix-copy-paste',
    qrCodeBase64: 'data:image/png;base64,aGVsbG8=',
    ...overrides,
  };
}

function signedWebhook(payload, secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return { rawBody, headers: { 'x-zpay-timestamp': timestamp, 'x-zpay-signature': signature } };
}

test('creates a Pix once and returns the persisted pending payment on repeat', async () => {
  const db = createPaymentDatabase();
  let calls = 0;
  const providers = {
    zpay: {
      async createPayment(request) {
        calls += 1;
        assert.equal(request.amount, 25);
        assert.equal(request.idempotencyKey, 'vanta-order-1');
        return providerPayment();
      },
    },
  };

  const first = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers,
    providerOrder: ['zpay', 'voxpay'],
  });
  const second = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers,
    providerOrder: ['zpay', 'voxpay'],
  });

  assert.equal(first.status, 'pending');
  assert.equal(second.id, first.id);
  assert.equal(calls, 1);
  const message = buildPixMessage(first, { id: 'order-1' });
  assert.equal(message.files.length, 1);
  assert.equal(message.embeds[0].toJSON().image.url, 'attachment://pix-order-1.png');
  assert.ok(message.components[0].toJSON());
  db.close();
});

test('Sandbox payments are visibly marked and never become production confirmations', async () => {
  const db = createPaymentDatabase();
  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers: {
      zpay: {
        environment: 'sandbox',
        async createPayment() {
          return providerPayment({
            paymentId: 'sbx_payment-1',
            status: 'paid',
            copyPaste: 'ZPAYSANDBOX-test',
          });
        },
      },
    },
    providerOrder: ['zpay'],
  });
  assert.equal(payment.environment, 'sandbox');
  assert.equal(payment.status, 'paid');
  const audit = db.prepare('SELECT action FROM audit_logs').get();
  assert.equal(audit.action, 'payment.sandbox_status');
  const message = buildPixMessage(payment, { id: 'order-1' });
  assert.match(message.embeds[0].toJSON().title, /SANDBOX/);
  assert.match(message.embeds[0].toJSON().description, /não libera entrega/);
  db.close();
});

test('falls back to the alternative provider after definitive invalid credentials', async () => {
  const db = createPaymentDatabase();
  let fallbackCalls = 0;
  const providers = {
    zpay: {
      async createPayment() {
        throw Object.assign(new Error('Unauthorized'), { status: 401, code: 'INVALID_API_KEY' });
      },
    },
    voxpay: {
      async createPayment() {
        fallbackCalls += 1;
        return providerPayment({ paymentId: 'vox-payment-1' });
      },
    },
  };

  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers,
    providerOrder: ['zpay', 'voxpay'],
  });
  assert.equal(payment.provider, 'voxpay');
  assert.equal(fallbackCalls, 1);
  assert.equal(db.prepare('SELECT status FROM payments WHERE provider = ?').get('zpay').status, 'failed');
  db.close();
});

test('does not fail over or retry when the provider outcome is uncertain', async () => {
  const db = createPaymentDatabase();
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const providers = {
    zpay: {
      async createPayment() {
        primaryCalls += 1;
        throw Object.assign(new Error('Timeout'), { code: 'REQUEST_TIMEOUT', outcomeUnknown: true });
      },
    },
    voxpay: { async createPayment() { fallbackCalls += 1; return providerPayment(); } },
  };
  const input = {
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers,
    providerOrder: ['zpay', 'voxpay'],
  };

  await assert.rejects(createOrderPayment(input), (error) => (
    error instanceof PaymentError && error.outcomeUnknown
  ));
  await assert.rejects(createOrderPayment(input), (error) => (
    error instanceof PaymentError && error.code === 'OUTCOME_UNKNOWN'
  ));
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(db.prepare('SELECT status FROM payments').get().status, 'outcome_unknown');
  db.close();
});

test('confirms valid paid webhooks idempotently and rejects sandbox or bad signatures', async () => {
  const db = createPaymentDatabase();
  const providers = {
    zpay: { async createPayment() { return providerPayment(); } },
  };
  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers,
    providerOrder: ['zpay'],
  });
  const secret = 'webhook-secret-for-tests';
  const event = {
    event: 'payment.paid',
    livemode: true,
    data: {
      id: payment.provider_payment_id,
      amount: 25,
      status: 'paid',
      paidAt: new Date().toISOString(),
    },
  };
  const valid = signedWebhook(event, secret);
  const input = { db, ...valid, secret };

  assert.equal(handleZpayWebhook(input).duplicate, false);
  assert.equal(handleZpayWebhook(input).duplicate, true);
  assert.equal(db.prepare('SELECT status FROM payments').get().status, 'paid');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 1);

  const invalid = signedWebhook({ ...event, livemode: false }, secret);
  assert.throws(() => handleZpayWebhook({
    db,
    ...invalid,
    headers: { ...invalid.headers, 'x-zpay-sandbox': '1' },
    secret,
  }), /Sandbox/);
  assert.throws(() => handleZpayWebhook({
    db,
    ...valid,
    headers: { ...valid.headers, 'x-zpay-signature': '0'.repeat(64) },
    secret,
  }), /Assinatura/);
  db.close();
});

test('queues a valid webhook that arrives before the create response is persisted', async () => {
  const db = createPaymentDatabase();
  const secret = 'webhook-secret-for-tests';
  const providers = {
    zpay: {
      async createPayment() {
        const event = {
          event: 'payment.paid',
          livemode: true,
          data: {
            id: 'early-payment',
            amount: 25,
            status: 'paid',
            paidAt: new Date().toISOString(),
          },
        };
        const signed = signedWebhook(event, secret);
        const receipt = handleZpayWebhook({ db, ...signed, secret });
        assert.equal(receipt.queued, true);
        return providerPayment({ paymentId: 'early-payment' });
      },
    },
  };

  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers,
    providerOrder: ['zpay'],
  });
  assert.equal(payment.status, 'paid');
  assert.equal(db.prepare(
    'SELECT payment_id FROM payment_webhook_events',
  ).get().payment_id, payment.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 1);
  db.close();
});

test('refreshes only from provider status and requires a matching amount', async () => {
  const db = createPaymentDatabase();
  let queriedId;
  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers: { zpay: { async createPayment() { return providerPayment(); } } },
    providerOrder: ['zpay'],
  });
  const refreshed = await refreshOrderPayment({
    db,
    orderId: 'order-1',
    providers: {
      zpay: {
        async getPayment(id) {
          queriedId = id;
          return providerPayment({ status: 'paid', paidAt: new Date().toISOString() });
        },
      },
    },
  });
  assert.equal(queriedId, 'zpay-payment-1');
  assert.equal(refreshed.status, 'paid');
  db.close();
});

test('configures Z.PAY from backend environment values and defaults it as primary', () => {
  class FakeClient {
    constructor(options) {
      this.options = options;
      this.payments = {
        create: async (data) => data,
        get: async (id) => ({ paymentId: id }),
      };
    }
  }
  const provider = createZpayProvider({
    clientId: 'client-id',
    clientSecret: 'secret',
    apiUrl: 'https://zpay.example/api/v1',
    Client: FakeClient,
  });
  assert.ok(provider);
  assert.equal(getPaymentProviderOrder({})[0], 'zpay');
  assert.deepEqual(getPaymentProviderOrder({ PAYMENT_PROVIDER: 'voxpay' }), ['voxpay', 'zpay']);
  assert.throws(() => getPaymentProviderOrder({ PAYMENT_PROVIDER: 'other' }), /must be zpay or voxpay/);
  assert.deepEqual(createPaymentProviders({}).providers, {});
});

test('Z.PAY Sandbox is isolated and simulation cannot be enabled in production', async () => {
  const clients = [];
  class FakeClient {
    constructor(options) {
      clients.push(options);
      this.payments = {
        create: async (data) => data,
        get: async (id) => ({ paymentId: id, amount: 25, status: 'paid' }),
      };
    }
  }
  const config = createPaymentProviders({
    PAYMENT_PROVIDER: 'zpay',
    ZPAY_ENVIRONMENT: 'sandbox',
    ZPAY_CLIENT_ID: 'test-client-id',
    ZPAY_CLIENT_SECRET: 'test-client-secret',
    VOXPAY_API_KEY: 'vp_live_test_key',
  }, { ZpayClient: FakeClient });
  assert.deepEqual(config.providerOrder, ['zpay']);
  assert.deepEqual(Object.keys(config.providers), ['zpay']);
  assert.equal(config.providers.zpay.environment, 'sandbox');
  assert.equal(clients[0].baseUrl, 'https://zpaysolution.com/api/v1/sandbox');
  await assert.rejects(createZpayProvider({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    Client: FakeClient,
  }).simulatePayment('payment-1', 'paid'), /only in Sandbox/);

  let simulationRequest;
  const sandbox = createZpayProvider({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    environment: 'sandbox',
    Client: FakeClient,
    fetchImpl: async (url, options) => {
      simulationRequest = { url, options };
      return new Response('', { status: 200 });
    },
  });
  const result = await sandbox.simulatePayment('sbx_payment-1', 'paid');
  assert.equal(result.status, 'paid');
  assert.equal(
    simulationRequest.url,
    'https://zpaysolution.com/api/v1/sandbox/payments/sbx_payment-1/simulate',
  );
  assert.deepEqual(JSON.parse(simulationRequest.options.body), { status: 'paid' });
  assert.throws(() => createPaymentProviders({
    PAYMENT_PROVIDER: 'voxpay',
    ZPAY_ENVIRONMENT: 'sandbox',
    ZPAY_CLIENT_ID: 'test',
    ZPAY_CLIENT_SECRET: 'test',
  }, { ZpayClient: FakeClient }), /requires PAYMENT_PROVIDER=zpay/);
});

test('payment schema migration adds new fields without dropping legacy payment data', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE orders (id TEXT PRIMARY KEY);
    CREATE TABLE payments (
      id TEXT PRIMARY KEY, order_id TEXT, provider TEXT, idempotency_key TEXT,
      amount_cents INTEGER, status TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE payment_webhook_events (
      event_hash TEXT PRIMARY KEY, provider TEXT, payment_id TEXT,
      event_type TEXT, received_at TEXT
    );
    INSERT INTO payments (id, order_id, provider, idempotency_key, amount_cents,
      status, created_at, updated_at)
    VALUES ('legacy-payment', 'order-legacy', 'zpay', 'key-legacy', 2000,
      'pending', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
  `);
  ensurePaymentSchema(db);
  ensurePaymentSchema(db);

  assert.equal(db.prepare('SELECT amount_cents FROM payments WHERE id = ?')
    .get('legacy-payment').amount_cents, 2000);
  assert.equal(db.prepare('SELECT environment FROM payments WHERE id = ?')
    .get('legacy-payment').environment, 'production');
  assert.ok(db.prepare('PRAGMA table_info(payments)').all()
    .some((column) => column.name === 'provider_fee_cents'));
  assert.ok(db.prepare('PRAGMA table_info(payment_webhook_events)').all()
    .some((column) => column.name === 'delivery_id'));
  db.close();
});

test('VoxPay adapter follows documented request and response units', async () => {
  const requests = [];
  const voxpay = createVoxPayProvider({
    apiKey: 'vp_live_test_key',
    apiUrl: 'https://voxpay.example/api/v1',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        data: {
          id: 'vox-charge-1',
          amount_cents: 2590,
          platform_fee_cents: 102,
          status: 'pending',
          payment_method: 'pix',
          pix_copy_paste: 'vox-pix-copy',
          pix_qr_code: 'data:image/png;base64,aGVsbG8=',
          expires_at: '2026-11-03T00:00:00.000Z',
        },
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  const created = await voxpay.createPayment({
    amount: 25.9,
    payerName: 'Cliente',
    description: 'Pedido order-1',
    idempotencyKey: 'vanta-order-1',
  });

  assert.equal(requests[0].url, 'https://voxpay.example/api/v1/charges');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer vp_live_test_key');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    amount: 25.9,
    external_reference: 'vanta-order-1',
    description: 'Pedido order-1',
    payment_method: 'pix',
    customer: { name: 'Cliente' },
  });
  assert.equal(created.amount, 25.9);
  assert.equal(created.feeCents, 102);
  assert.equal(created.copyPaste, 'vox-pix-copy');
  assert.equal(created.status, 'pending');
});

test('VoxPay approved webhook confirms once using the documented delivery signature', async () => {
  const db = createPaymentDatabase();
  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers: {
      voxpay: {
        async createPayment() {
          return providerPayment({ paymentId: 'vox-charge-1' });
        },
      },
    },
    providerOrder: ['voxpay', 'zpay'],
  });
  const secret = 'voxpay-webhook-secret';
  const rawBody = Buffer.from(JSON.stringify({
    id: 'delivery-1',
    event: 'payment.approved',
    createdAt: new Date().toISOString(),
    data: {
      id: 'vox-charge-1',
      amount_cents: 2500,
      platform_fee_cents: 99,
      status: 'approved',
      approved_at: new Date().toISOString(),
    },
  }));
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  const input = {
    db,
    rawBody,
    secret,
    headers: {
      'x-voxpay-event': 'payment.approved',
      'x-voxpay-delivery': 'delivery-1',
      'x-voxpay-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-voxpay-signature': `sha256=${signature}`,
    },
  };
  assert.equal(handleVoxPayWebhook(input).duplicate, false);
  assert.equal(handleVoxPayWebhook(input).duplicate, true);
  const saved = db.prepare('SELECT status, provider_fee_cents FROM payments WHERE id = ?')
    .get(payment.id);
  assert.equal(saved.status, 'paid');
  assert.equal(saved.provider_fee_cents, 99);
  assert.throws(() => handleVoxPayWebhook({
    ...input,
    headers: { ...input.headers, 'x-voxpay-signature': `sha256=${'0'.repeat(64)}` },
  }), /Assinatura/);
  db.close();
});

test('VoxPay uncertain outcome never triggers Z.PAY or an automatic retry', async () => {
  const db = createPaymentDatabase();
  let zpayCalls = 0;
  const voxpay = createVoxPayProvider({
    apiKey: 'vp_live_test_key',
    apiUrl: 'https://voxpay.example/api/v1',
    fetchImpl: async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  const input = {
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers: {
      voxpay,
      zpay: {
        async createPayment() {
          zpayCalls += 1;
          return providerPayment();
        },
      },
    },
    providerOrder: ['voxpay', 'zpay'],
  };
  await assert.rejects(createOrderPayment(input), (error) => (
    error instanceof PaymentError && error.outcomeUnknown
  ));
  await assert.rejects(createOrderPayment(input), (error) => (
    error instanceof PaymentError && error.code === 'OUTCOME_UNKNOWN'
  ));
  assert.equal(zpayCalls, 0);
  assert.equal(db.prepare('SELECT status FROM payments').get().status, 'outcome_unknown');
  db.close();
});

test('VoxPay documented auth/configuration errors fall back to Z.PAY', async () => {
  const db = createPaymentDatabase();
  const voxpay = createVoxPayProvider({
    apiKey: 'vp_live_test_key',
    apiUrl: 'https://voxpay.example/api/v1',
    fetchImpl: async () => new Response(
      JSON.stringify({ error: 'provider_auth_failed' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ),
  });
  let zpayCalls = 0;
  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers: {
      voxpay,
      zpay: {
        async createPayment() {
          zpayCalls += 1;
          return providerPayment({ paymentId: 'zpay-fallback-payment' });
        },
      },
    },
    providerOrder: ['voxpay', 'zpay'],
  });
  assert.equal(payment.provider, 'zpay');
  assert.equal(zpayCalls, 1);
  db.close();
});

test('orders outside Z.PAY limits use the configured VoxPay limits instead', async () => {
  const db = createPaymentDatabase();
  db.prepare('UPDATE orders SET subtotal_cents = 250100, total_cents = 250100 WHERE id = ?')
    .run('order-1');
  let zpayCalls = 0;
  const payment = await createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers: {
      zpay: { async createPayment() { zpayCalls += 1; return providerPayment(); } },
      voxpay: {
        async createPayment(input) {
          assert.equal(input.amount, 2501);
          return providerPayment({ paymentId: 'vox-high-value', amount: 2501 });
        },
      },
    },
    providerOrder: ['zpay', 'voxpay'],
  });
  assert.equal(payment.provider, 'voxpay');
  assert.equal(zpayCalls, 0);
  db.close();
});

test('VoxPay timeout with a charge id is recovered through the original status endpoint', async () => {
  const db = createPaymentDatabase();
  let requestCount = 0;
  const voxpay = createVoxPayProvider({
    apiKey: 'vp_live_test_key',
    apiUrl: 'https://voxpay.example/api/v1',
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          error: 'provider_timeout',
          charge_id: 'vox-charge-recover',
        }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: {
          id: 'vox-charge-recover',
          amount_cents: 2500,
          status: 'approved',
          approved_at: new Date().toISOString(),
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await assert.rejects(createOrderPayment({
    db,
    orderId: 'order-1',
    payerName: 'Cliente',
    providers: { voxpay, zpay: { async createPayment() { assert.fail('must not fail over'); } } },
    providerOrder: ['voxpay', 'zpay'],
  }), (error) => error instanceof PaymentError && error.outcomeUnknown);

  const stored = db.prepare('SELECT provider_payment_id, status FROM payments').get();
  assert.equal(stored.provider_payment_id, 'vox-charge-recover');
  assert.equal(stored.status, 'outcome_unknown');
  const recovered = await refreshOrderPayment({
    db,
    orderId: 'order-1',
    providers: { voxpay },
  });
  assert.equal(recovered.status, 'paid');
  assert.equal(requestCount, 2);
  db.close();
});

test('provider records failed and expired statuses without treating them as paid', async () => {
  for (const status of ['expired', 'failed']) {
    const db = createPaymentDatabase();
    const payment = await createOrderPayment({
      db,
      orderId: 'order-1',
      payerName: 'Cliente',
      providers: {
        zpay: { async createPayment() { return providerPayment({ status }); } },
      },
      providerOrder: ['zpay'],
    });
    assert.equal(payment.status, status);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 0);
    db.close();
  }
});
