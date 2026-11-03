import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearNvidiaModelCache,
  DEFAULT_NVIDIA_MODEL,
  getAvailableNvidiaModels,
  resolveAvailableNvidiaModel,
} from '../src/services/nvidia.js';

test('model discovery returns only the account-supported OpenAI GPT-OSS model', async () => {
  clearNvidiaModelCache();
  const models = await getAvailableNvidiaModels({
    apiKey: 'sensitive-test-key',
    forceRefresh: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://integrate.api.nvidia.com/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer sensitive-test-key');
      return Response.json({
        data: [
          { id: 'openai/gpt-oss-20b' },
          { id: 'z-ai/glm-5.3-flash' },
          { id: 'unrelated/model' },
          { id: 'openai/gpt-oss-20b' },
        ],
      });
    },
  });
  assert.deepEqual(models, [DEFAULT_NVIDIA_MODEL]);
});

test('GPT-OSS is selected when available and legacy GLM preferences cannot select Flash', async () => {
  clearNvidiaModelCache();
  const selected = await resolveAvailableNvidiaModel(
    DEFAULT_NVIDIA_MODEL,
    'test-key',
    {
      forceRefresh: true,
      fetchImpl: async () => Response.json({
        data: [{ id: 'openai/gpt-oss-20b' }, { id: 'z-ai/glm-5.3-flash' }],
      }),
    },
  );
  assert.equal(selected, DEFAULT_NVIDIA_MODEL);

  clearNvidiaModelCache();
  const migratedPreference = await resolveAvailableNvidiaModel(
    'z-ai/glm-5.3-flash',
    'test-key',
    {
      forceRefresh: true,
      fetchImpl: async () => Response.json({
        data: [{ id: 'openai/gpt-oss-20b' }, { id: 'z-ai/glm-5.3-flash' }],
      }),
    },
  );
  assert.equal(migratedPreference, DEFAULT_NVIDIA_MODEL);
});

test('model discovery surfaces rejected access and unavailable GPT-OSS access', async () => {
  clearNvidiaModelCache();
  await assert.rejects(getAvailableNvidiaModels({
    apiKey: 'test-key',
    forceRefresh: true,
    fetchImpl: async () => new Response(null, { status: 401 }),
  }), /HTTP 401/);

  clearNvidiaModelCache();
  await assert.rejects(resolveAvailableNvidiaModel(
    DEFAULT_NVIDIA_MODEL,
    'test-key',
    {
      forceRefresh: true,
      fetchImpl: async () => Response.json({
        data: [{ id: 'z-ai/glm-5.3-flash' }, { id: 'unrelated/model' }],
      }),
    },
  ), /openai\/gpt-oss-20b não está disponível/);
});
