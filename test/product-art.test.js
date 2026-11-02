import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import sharp from 'sharp';
import { getProductImagePath } from '../src/config/productImages.js';
import { DEFAULT_CATALOG_PRODUCTS } from '../src/services/commerce.js';

test('every default product has a distinct square PNG artwork', async () => {
  const hashes = new Set();

  for (const [name, category] of DEFAULT_CATALOG_PRODUCTS) {
    const path = getProductImagePath(category, name);
    assert.ok(existsSync(path), `Missing product artwork for ${name}`);

    const image = readFileSync(path);
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 1024);

    const hash = createHash('sha256').update(image).digest('hex');
    assert.ok(!hashes.has(hash), `Artwork is duplicated for ${name}`);
    hashes.add(hash);
  }

  assert.equal(hashes.size, DEFAULT_CATALOG_PRODUCTS.length);
});
