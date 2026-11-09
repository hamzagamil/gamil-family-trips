// Turns raw phone screenshots into store-ready images.
//   1. Put screenshots in screenshots/raw/ (PNG or JPEG, any phone).
//      The file name becomes the caption, after an optional number prefix:
//        "1 - See all of today's trips.png"  →  caption "See all of today's trips"
//        Name a file "2.png" (number only) for no caption.
//   2. node scripts/make-screenshots.mjs
// Output:
//   store-assets/play-screenshots/play-1080x1920-NN.png                   Google Play phone (9:16)
//   store-assets/ios-screenshots/appstore-iphone-medium-1206x2622-NN.png  App Store, "iPhone with Dynamic Island (medium display)"
//   store-assets/ios-screenshots/appstore-iphone-large-1320x2868-NN.png   App Store, large iPhone (6.9") if asked for

import sharp from 'sharp';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, parse } from 'node:path';

const RAW = 'screenshots/raw';
const TARGETS = [
    { dir: 'store-assets/play-screenshots', prefix: 'play-1080x1920', width: 1080, height: 1920 },
    // App Store Connect: "iPhone with Dynamic Island (medium display)" slot, 6.1"/6.3" (1206×2622)
    { dir: 'store-assets/ios-screenshots', prefix: 'appstore-iphone-medium-1206x2622', width: 1206, height: 2622 },
    // Large iPhone (6.9") size, in case App Store Connect asks for it separately
    { dir: 'store-assets/ios-screenshots', prefix: 'appstore-iphone-large-1320x2868', width: 1320, height: 2868 }
];

const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function background(width, height, caption) {
    const fontSize = Math.round(width * 0.062);
    // Wrap the caption to at most 2 lines of ~22 characters
    const words = caption.split(/\s+/).filter(Boolean);
    const lines = [];
    for (const w of words) {
        const last = lines[lines.length - 1];
        if (last && (last + ' ' + w).length <= 26) lines[lines.length - 1] = last + ' ' + w;
        else lines.push(w);
    }
    const text = lines.slice(0, 2).map((line, i) =>
        `<text x="50%" y="${Math.round(height * 0.075) + i * fontSize * 1.2}" text-anchor="middle"
          font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize}"
          font-weight="700" fill="#fff">${escapeXml(line)}</text>`).join('');
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5b5ef0"/><stop offset="1" stop-color="#06c8dc"/>
      </linearGradient></defs>
      <rect width="${width}" height="${height}" fill="url(#g)"/>
      ${text}
    </svg>`);
}

async function frame(file, { width, height }, caption) {
    const top = caption ? Math.round(height * 0.17) : Math.round(height * 0.05);
    const bottom = Math.round(height * 0.04);
    const maxW = Math.round(width * 0.84);
    const maxH = height - top - bottom;

    // Screenshot scaled to fit, with rounded corners like a phone screen
    const shot = sharp(file).resize(maxW, maxH, { fit: 'inside' });
    const { data, info } = await shot.png().toBuffer({ resolveWithObject: true });
    const r = Math.round(info.width * 0.06);
    const mask = Buffer.from(`<svg width="${info.width}" height="${info.height}"><rect width="${info.width}" height="${info.height}" rx="${r}" fill="#fff"/></svg>`);
    const rounded = await sharp(data).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();

    // Centre the screenshot in the space below the caption (wide shots leave room)
    const y = top + Math.max(0, Math.round((maxH - info.height) / 2));
    return sharp(background(width, height, caption))
        .composite([{ input: rounded, left: Math.round((width - info.width) / 2), top: y }])
        .flatten({ background: '#0a0e1a' })
        .removeAlpha()
        .png();
}

const files = readdirSync(RAW).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
if (files.length === 0) {
    console.error(`No screenshots in ${RAW}/`);
    process.exit(1);
}
for (const t of TARGETS) mkdirSync(t.dir, { recursive: true });

for (const [i, f] of files.entries()) {
    const caption = parse(f).name.replace(/^\s*\d+\s*[-_.)]?\s*/, '').trim();
    for (const t of TARGETS) {
        const out = join(t.dir, `${t.prefix}-${String(i + 1).padStart(2, '0')}.png`);
        await (await frame(join(RAW, f), t, caption)).toFile(out);
    }
    console.log(`${f} → ${caption ? `"${caption}"` : '(no caption)'}`);
}
console.log(`Wrote ${files.length} screenshot(s) to ${TARGETS.map((t) => t.dir).join(' and ')}`);
