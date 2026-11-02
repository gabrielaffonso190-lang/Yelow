import { resolve } from 'node:path';

export function slugProductAsset(value) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getProductImagePath(category, name) {
  return resolve(
    'assets/products',
    slugProductAsset(category),
    `${slugProductAsset(name)}.png`,
  );
}
