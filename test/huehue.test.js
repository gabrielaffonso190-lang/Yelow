import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HuehueServiceError,
  requestHuehueCompletion,
} from '../src/services/huehue.js';

test('Huehue chat sends the documented bearer request and reads a text answer', async () => {
  let request;
  const answer = await requestHuehueCompletion({
    apiKey: 'test-key',
    message: 'Explique webhook.',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ resposta: 'Um webhook envia eventos para outro sistema.' });
    },
  });

  assert.equal(request.url, 'https://huehue.app/v1/chatgpt');
  assert.equal(request.options.method, 'POST');
  const [scheme, key] = request.options.headers.Authorization.split(' ');
  assert.equal(scheme, ['Be', 'arer'].join(''));
  assert.equal(key, 'test-key');
  assert.deepEqual(JSON.parse(request.options.body), { mensagem: 'Explique webhook.' });
  assert.equal(answer, 'Um webhook envia eventos para outro sistema.');
});

test('Huehue accepts a plain-text response and rejects provider failures safely', async () => {
  const answer = await requestHuehueCompletion({
    apiKey: 'test-key',
    message: 'Pergunta',
    fetchImpl: async () => new Response('Resposta em texto.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }),
  });
  assert.equal(answer, 'Resposta em texto.');

  const nestedAnswer = await requestHuehueCompletion({
    apiKey: 'test-key',
    message: 'Pergunta',
    fetchImpl: async () => Response.json({
      success: true,
      data: { text: 'Resposta estruturada.' },
    }),
  });
  assert.equal(nestedAnswer, 'Resposta estruturada.');

  await assert.rejects(requestHuehueCompletion({
    apiKey: 'test-key',
    message: 'Pergunta',
    fetchImpl: async () => new Response(null, { status: 401 }),
  }), (error) => error instanceof HuehueServiceError && /HTTP 401/.test(error.message));

  await assert.rejects(requestHuehueCompletion({
    apiKey: 'test-key',
    message: 'Pergunta',
    fetchImpl: async () => Response.json({ success: false, error: 'private error text' }),
  }), (error) => error instanceof HuehueServiceError
    && !error.message.includes('private error text'));

  await assert.rejects(requestHuehueCompletion({
    apiKey: 'test-key',
    message: 'Pergunta',
    fetchImpl: async () => new Response('resposta', {
      headers: { 'content-length': String(70 * 1024) },
    }),
  }), /excedeu o limite de tamanho/);
});
