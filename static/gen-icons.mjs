// 由 static/icon.svg 生成 PWA 所需 PNG 图标 -> static/icons/
// 本地：npm i -D sharp && node scripts/gen-icons.mjs
// CI：workflow 会把 sharp 装到 /tmp/icongen 并通过 SHARP_DIR 指定
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const req = createRequire(process.env.SHARP_DIR ? path.join(process.env.SHARP_DIR, 'x.js') : import.meta.url);
const sharp = req('sharp');

const src = ['static/icon.svg'].find(existsSync);
if (!src) throw new Error('找不到 static/icon.svg');
mkdirSync('static/icons', { recursive: true });

const bg = { r: 0, g: 0, b: 0, alpha: 0 };
for (const s of [192, 512]) {
  await sharp(src, { density: 384 }).resize(s, s, { fit: 'contain', background: bg }).png().toFile(`static/icons/icon-${s}.png`);
}
// maskable：内容缩到 80%，四周留安全区，底色用主题色
const inner = await sharp(src, { density: 384 }).resize(410, 410, { fit: 'contain', background: bg }).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#415F91' } })
  .composite([{ input: inner, gravity: 'center' }]).png().toFile('static/icons/icon-maskable-512.png');
console.log('icons generated');
