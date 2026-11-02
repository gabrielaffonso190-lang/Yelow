import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { slugProductAsset } from '../config/productImages.js';
import { DEFAULT_CATALOG_PRODUCTS } from '../services/commerce.js';

function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

function productArt(product, index) {
  const category = escapeXml(product[1].toUpperCase());
  const title = escapeXml(product[0]);
  const accent = index % 2 ? '#A0A0A0' : '#FFFFFF';
  const offset = 288 + (index % 5) * 9;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect width="1024" height="1024" fill="#090909"/>
    <rect x="64" y="64" width="896" height="896" rx="32" fill="#151515" stroke="#303030" stroke-width="2"/>
    <path d="M512 176c116 0 210 94 210 210S628 596 512 596s-210-94-210-210 94-210 210-210Z" fill="#202020" stroke="${accent}" stroke-opacity=".72" stroke-width="3"/>
    <path d="M512 248 654 493H370l142-245Z" fill="none" stroke="${accent}" stroke-width="5"/>
    <circle cx="512" cy="388" r="${offset}" fill="none" stroke="#303030" stroke-width="2"/>
    <path d="M280 730h464" stroke="#303030" stroke-width="2"/>
    <text x="512" y="674" fill="#A0A0A0" font-family="Arial,sans-serif" font-size="24" letter-spacing="8" text-anchor="middle">${category}</text>
    <text x="512" y="790" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="42" font-weight="600" text-anchor="middle">${title}</text>
    <text x="512" y="870" fill="#A0A0A0" font-family="Arial,sans-serif" font-size="18" letter-spacing="4" text-anchor="middle">VANTA · THIRD-PARTY DIGITAL PRODUCT</text>
    <text x="512" y="918" fill="#A0A0A0" font-family="Arial,sans-serif" font-size="16" letter-spacing="3" text-anchor="middle">VANTA - 2027</text>
  </svg>`;
}

let created = 0;
for (const [index, product] of DEFAULT_CATALOG_PRODUCTS.entries()) {
  const [name, category] = product;
  const output = resolve(
    'assets/products',
    slugProductAsset(category),
    `${slugProductAsset(name)}.png`,
  );
  await mkdir(dirname(output), { recursive: true });
  const svg = Buffer.from(productArt(product, index));
  await sharp(svg).png({ compressionLevel: 9 }).toFile(output);
  created += 1;
}

await writeFile(
  resolve('assets/products/manifest.json'),
  `${JSON.stringify(DEFAULT_CATALOG_PRODUCTS.map(([name, category]) => ({
    name,
    category,
    image: `${slugProductAsset(category)}/${slugProductAsset(name)}.png`,
  })), null, 2)}\n`,
);
console.log(`Generated ${created} unique square product images.`);
