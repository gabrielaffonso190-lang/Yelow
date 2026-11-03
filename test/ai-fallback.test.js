import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { clearNvidiaModelCache } from '../src/services/nvidia.js';
import { respondToMessage } from '../src/services/ai.js';

function withEnv(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      clearNvidiaModelCache();
    });
}

function requestContext() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}',
      staff_role_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      messages TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id, user_id)
    );
  `);
  return {
    db,
    guild: { id: 'guild-1', client: { user: { id: 'bot-1' } } },
    channelId: 'channel-1',
    user: { id: 'user-1' },
    member: {},
    content: 'Explique o que é um webhook.',
  };
}

test('NVIDIA errors fall back to Huehue GPT-5 mini and save the conversation', async () => {
  await withEnv({
    NVIDIA_API_KEY: 'nvidia-test-key',
    HUEHUE_API_KEY: 'huehue-test-key',
  }, async () => {
    const context = requestContext();
    const requests = [];
    clearNvidiaModelCache();
    const result = await respondToMessage({
      ...context,
      fetchImpl: async (url, options) => {
        requests.push(String(url));
        if (String(url).endsWith('/models')) {
          return Response.json({ data: [{ id: 'openai/gpt-oss-20b' }] });
        }
        if (String(url).includes('/chat/completions')) {
          throw new Error('provider connection failure');
        }
        assert.equal(String(url), 'https://huehue.app/v1/chatgpt');
        const [scheme, key] = options.headers.Authorization.split(' ');
        assert.equal(scheme, ['Be', 'arer'].join(''));
        assert.equal(key, 'huehue-test-key');
        assert.match(JSON.parse(options.body).mensagem, /Explique o que é um webhook/);
        return Response.json({ resposta: 'Um webhook envia eventos entre sistemas.' });
      },
    });

    assert.match(result.content, /Resposta via Huehue GPT-5 mini/);
    assert.match(result.content, /envia eventos/);
    assert.ok(requests.some((url) => url.endsWith('/models')));
    assert.ok(requests.some((url) => url.endsWith('/chat/completions')));
    assert.ok(requests.some((url) => url.endsWith('/v1/chatgpt')));
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 1);
    context.db.close();
  });
});

test('Huehue works when NVIDIA is not configured', async () => {
  await withEnv({
    NVIDIA_API_KEY: undefined,
    HUEHUE_API_KEY: 'huehue-test-key',
  }, async () => {
    const context = requestContext();
    const result = await respondToMessage({
      ...context,
      fetchImpl: async (url) => {
        assert.equal(String(url), 'https://huehue.app/v1/chatgpt');
        return new Response('Resposta direta do fallback.', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    });

    assert.match(result.content, /Resposta direta do fallback/);
    context.db.close();
  });
});

test('NVIDIA retries a transient failure once and preserves the newest extended conversation context', async () => {
  await withEnv({
    NVIDIA_API_KEY: 'nvidia-test-key',
    HUEHUE_API_KEY: undefined,
    AI_RETRY_ATTEMPTS: '1',
    AI_HISTORY_MESSAGES: '24',
  }, async () => {
    const context = requestContext();
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `historico-${index}`,
    }));
    context.db.prepare(`
      INSERT INTO conversations (guild_id, channel_id, user_id, messages, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('guild-1', 'channel-1', 'user-1', JSON.stringify(history), new Date().toISOString());

    clearNvidiaModelCache();
    let completionAttempts = 0;
    let prompt;
    const result = await respondToMessage({
      ...context,
      fetchImpl: async (url, options) => {
        if (String(url).endsWith('/models')) {
          return Response.json({ data: [{ id: 'openai/gpt-oss-20b' }] });
        }
        completionAttempts += 1;
        assert.ok(options.signal);
        prompt = JSON.parse(options.body).messages;
        if (completionAttempts === 1) return new Response('temporarily unavailable', { status: 503 });
        return Response.json({ choices: [{ message: { content: 'Resposta recuperada.' } }] });
      },
    });

    assert.equal(completionAttempts, 2);
    assert.match(result.content, /Resposta recuperada/);
    assert.ok(prompt.some((message) => message.content === 'historico-39'));
    assert.ok(!prompt.some((message) => message.content === 'historico-0'));
    assert.equal(JSON.parse(context.db.prepare(
      'SELECT messages FROM conversations WHERE guild_id = ? AND channel_id = ? AND user_id = ?',
    ).get('guild-1', 'channel-1', 'user-1').messages).length, 24);
    context.db.close();
  });
});

test('Huehue retries one transient 502 and returns the recovered answer', async () => {
  await withEnv({
    NVIDIA_API_KEY: undefined,
    HUEHUE_API_KEY: 'huehue-test-key',
    AI_RETRY_ATTEMPTS: '1',
  }, async () => {
    const context = requestContext();
    let attempts = 0;
    const result = await respondToMessage({
      ...context,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return new Response('upstream unavailable', { status: 502 });
        return new Response('Serviço recuperado.', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    });
    assert.equal(attempts, 2);
    assert.match(result.content, /Serviço recuperado/);
    context.db.close();
  });
});
