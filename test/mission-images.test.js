import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMissionImage } from '../src/services/missionImages.js';

function publicLookup() {
  return [{ address: '93.184.216.34', family: 4 }];
}

test('mission image validation accepts only public HTTPS image URLs with a bounded image size', async () => {
  const image = await validateMissionImage('https://images.example.test/banner', {
    lookupImpl: async () => publicLookup(),
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://images.example.test/banner');
      assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'error');
      return new Response(null, {
        headers: {
          'content-type': 'image/webp',
          'content-length': '1024',
        },
      });
    },
  });

  assert.deepEqual(image, {
    url: 'https://images.example.test/banner',
    mimeType: 'image/webp',
    sizeBytes: 1024,
  });
});

test('mission image validation rejects local addresses, unsafe types, and excessive sizes', async () => {
  await assert.rejects(validateMissionImage('https://127.0.0.1/banner.png', {
    fetchImpl: async () => assert.fail('A local host must not be fetched.'),
  }), /IPs públicos/);

  for (const headers of [
    { 'content-type': 'text/html', 'content-length': '100' },
    { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) },
  ]) {
    await assert.rejects(validateMissionImage('https://images.example.test/banner', {
      lookupImpl: async () => publicLookup(),
      fetchImpl: async () => new Response(null, { headers }),
    }));
  }
});
