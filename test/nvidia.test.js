import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearNvidiaModelCache,
  getAvailableNvidiaModels,
  resolveAvailableNvidiaModel,
} from '../src/services/nvidia.js';

test('model discovery returns only supported GLM IDs and never prints credentials', async () => {
  clearNvidiaModelCache();
  const models = await getAvailableNvidiaModels({
    apiKey: 'sensitive-test-key',
    forceRefresh: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://integrate.api.nvidia.com/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer sensitive-test-key');
      return Response.json({
        data: [
          { id: 'z-ai/glm-5.3-flash' },
          { id: 'unrelated/model' },
          { id: 'z-ai/glm-5.3-flash' },
        ],
      });
    },
  });
  assert.deepEqual(models, ['z-ai/glm-5.3-flash']);
});

test('primary GLM falls back only to a model explicitly available to the account', async () => {
  clearNvidiaModelCache();
  const selected = await resolveAvailableNvidiaModel(
    'z-ai/glm-5.3',
    'test-key',
    {
      forceRefresh: true,
      fetchImpl: async () => Response.json({
        data: [{ id: 'z-ai/glm-5.3-flash' }],
      }),
    },
  );
  assert.equal(selected, 'z-ai/glm-5.3-flash');

  clearNvidiaModelCache();
  const primary = await resolveAvailableNvidiaModel(
    'z-ai/glm-5.3',
    'test-key',
    {
      forceRefresh: true,
      fetchImpl: async () => Response.json({
        data: [{ id: 'z-ai/glm-5.3' }, { id: 'z-ai/glm-5.3-flash' }],
      }),
    },
  );
  assert.equal(primary, 'z-ai/glm-5.3');
});

test('model discovery surfaces rejected access and does not fall back without model access', async () => {
  clearNvidiaModelCache();
  await assert.rejects(getAvailableNvidiaModels({
    apiKey: 'test-key',
    forceRefresh: true,
    fetchImpl: async () => new Response(null, { status: 401 }),
  }), /HTTP 401/);

  clearNvidiaModelCache();
  await assert.rejects(resolveAvailableNvidiaModel(
    'z-ai/glm-5.3',
    'test-key',
    {
      forceRefresh: true,
      fetchImpl: async () => Response.json({ data: [{ id: 'unrelated/model' }] }),
    },
  ), /Nenhum dos modelos GLM compatíveis/);
});
