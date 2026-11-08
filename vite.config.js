import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Fills the placeholders in dist/firebase-messaging-sw.js:
 *   BUILD_ID         — hash of the whole build, so every deploy installs a new
 *                      service worker and refreshes the cached app shell
 *   PRECACHE_ASSETS  — the content-hashed JS/CSS files, pre-cached on install
 */
function serviceWorkerManifest() {
    let outDir;
    let buildId = '';
    let assets = [];

    return {
        name: 'tripsync-sw-manifest',
        apply: 'build',
        enforce: 'post', // run after Vite has added index.html to the bundle, so it's hashed too
        configResolved(config) {
            outDir = resolve(config.root, config.build.outDir);
        },
        generateBundle(_options, bundle) {
            if (!bundle["index.html"]) this.warn("index.html not in bundle yet — build ID will ignore HTML changes");
            const hash = createHash('sha256');
            assets = [];
            for (const fileName of Object.keys(bundle).sort()) {
                const output = bundle[fileName];
                hash.update(fileName);
                hash.update(output.type === 'chunk' ? output.code : output.source);
                if (fileName.startsWith('assets/')) assets.push('/' + fileName);
            }
            buildId = hash.digest('hex').slice(0, 12);
        },
        closeBundle() {
            const swPath = resolve(outDir, 'firebase-messaging-sw.js');
            const source = readFileSync(swPath, 'utf8');
            const output = source
                .replace(`'__BUILD_ID__'`, JSON.stringify(buildId))
                .replace('[/* __PRECACHE_ASSETS__ */]', JSON.stringify(assets));
            if (!output.includes(buildId) || output.includes('__PRECACHE_ASSETS__')) {
                throw new Error('[tripsync-sw-manifest] placeholders not found in firebase-messaging-sw.js');
            }
            writeFileSync(swPath, output);
            console.log(`[tripsync-sw-manifest] build ${buildId}, ${assets.length} assets pre-cached`);
        }
    };
}

export default defineConfig({
    plugins: [serviceWorkerManifest()],
    server: { port: 8080 }
});
