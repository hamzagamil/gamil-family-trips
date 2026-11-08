// Generates the source artwork for app icons, splash screens and store graphics.
//   node scripts/make-icons.mjs && npx capacitor-assets generate
// Output: assets/ (input for @capacitor/assets) and store-assets/ (upload by hand).

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const CAR = 'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3.21 11.4c-.14.42-.21.86-.21 1.31v6.79c0 .83.67 1.5 1.5 1.5S6 20.33 6 19.5V19h12v.5c0 .82.67 1.5 1.5 1.5.82 0 1.5-.67 1.5-1.5v-6.79c0-.44-.07-.89-.21-1.31l-1.87-5.39zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.27-3.82c.14-.4.52-.68.95-.68h9.56c.43 0 .81.28.95.68L19 11H5z';
const BG = '#0a0e1a';

const gradient = `
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#5b5ef0"/>
    <stop offset="1" stop-color="#06c8dc"/>
  </linearGradient>`;

// White car centred in a size×size box, occupying `scale` of its width
function car(size, scale, offsetX = 0, offsetY = 0) {
    const s = (size * scale) / 24;
    const x = offsetX + (size - 24 * s) / 2;
    const y = offsetY + (size - 24 * s) / 2 - s * 0.5; // glyph sits slightly low in its box
    return `<path d="${CAR}" fill="#fff" transform="translate(${x} ${y}) scale(${s})"/>`;
}

function icon(size, { background = true, scale = 0.6, rounded = false } = {}) {
    const r = rounded ? size * 0.2237 : 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs>${gradient}</defs>
      ${background ? `<rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>` : ''}
      ${car(size, scale)}
    </svg>`;
}

const png = (svg, file) => sharp(Buffer.from(svg)).png().toFile(file);

mkdirSync('assets', { recursive: true });
mkdirSync('store-assets', { recursive: true });

// App icon (iOS: full-bleed square, the OS rounds it; no transparency allowed)
await png(icon(1024), 'assets/icon-only.png');
// Android adaptive icon: background layer + foreground inside the 66% safe zone
await png(icon(1024, { background: false, scale: 0.42 }), 'assets/icon-foreground.png');
await png(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs>${gradient}</defs><rect width="1024" height="1024" fill="url(#g)"/></svg>`, 'assets/icon-background.png');

// Splash: dark app background with the rounded icon in the middle
const splash = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>${gradient}</defs>
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="translate(${(size - 480) / 2} ${(size - 480) / 2})">
    <rect width="480" height="480" rx="107" fill="url(#g)"/>
    ${car(480, 0.6)}
  </g>
</svg>`;
await png(splash(2732), 'assets/splash.png');
await png(splash(2732), 'assets/splash-dark.png');

// Google Play listing: 512×512 icon and 1024×500 feature graphic
await png(icon(512), 'store-assets/play-icon-512.png');
await png(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500">
  <defs>${gradient}</defs>
  <rect width="1024" height="500" fill="url(#g)"/>
  <g transform="translate(96 130)">
    <rect width="240" height="240" rx="54" fill="${BG}" fill-opacity="0.25"/>
    ${car(240, 0.62)}
  </g>
  <text x="380" y="235" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="62" font-weight="700" fill="#fff">Gamil Family Trips</text>
  <text x="384" y="300" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="34" fill="#fff" fill-opacity="0.9">Coordinate daily trips with your team</text>
</svg>`, 'store-assets/play-feature-graphic.png');

console.log('Icons written to assets/ and store-assets/');
