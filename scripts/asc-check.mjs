// Checks TripSync's setup in App Store Connect / the Apple Developer portal.
//   node scripts/asc-check.mjs <path-to-AuthKey_XXXX.p8> <issuer-id>
// Prints only non-secret facts: the app record, the App ID and its
// capabilities, and the provisioning profile.

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const BUNDLE_ID = 'com.dailytripplanner.app';
const PROFILE_NAME = 'TripSync App Store';

const [keyPath, issuer] = process.argv.slice(2);
if (!keyPath || !issuer) {
    console.error('usage: node scripts/asc-check.mjs <AuthKey_XXXX.p8> <issuer-id>');
    process.exit(2);
}
const keyId = basename(keyPath).match(/AuthKey_(\w+)\.p8$/)?.[1];
if (!keyId) throw new Error('Key file must be named AuthKey_<KEYID>.p8');

// ES256 JWT, valid 10 minutes
const b64url = (b) => Buffer.from(b).toString('base64url');
const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
const now = Math.floor(Date.now() / 1000);
const payload = b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
const key = createPrivateKey(readFileSync(keyPath));
const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
const token = `${header}.${payload}.${b64url(signature)}`;

async function api(path) {
    const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${path}: ${body.errors?.map((e) => e.detail).join('; ')}`);
    return body;
}

const ok = (b) => (b ? '✔' : '✘');

const apps = await api(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name,bundleId,sku,primaryLocale`);
const app = apps.data[0];
console.log(`${ok(app)} App Store Connect app: ${app
    ? `"${app.attributes.name}" (Apple ID ${app.id}, SKU ${app.attributes.sku}, ${app.attributes.primaryLocale})`
    : 'not found for ' + BUNDLE_ID}`);

const ids = await api(`/v1/bundleIds?filter[identifier]=${BUNDLE_ID}&include=bundleIdCapabilities`);
const bundle = ids.data.find((b) => b.attributes.identifier === BUNDLE_ID);
console.log(`${ok(bundle)} App ID: ${bundle ? `${bundle.attributes.name} (${bundle.attributes.platform})` : 'not registered'}`);
if (bundle) {
    const caps = (ids.included || [])
        .filter((i) => i.type === 'bundleIdCapabilities')
        .map((c) => c.attributes.capabilityType);
    console.log(`  ${ok(caps.includes('PUSH_NOTIFICATIONS'))} Push Notifications`);
    console.log(`  ${ok(caps.includes('APPLE_ID_AUTH'))} Sign in with Apple`);
    console.log(`  capabilities: ${caps.join(', ') || '(none)'}`);
}

const profiles = await api(`/v1/profiles?filter[name]=${encodeURIComponent(PROFILE_NAME)}&fields[profiles]=name,profileType,profileState,expirationDate`);
const profile = profiles.data[0];
console.log(`${ok(profile)} Profile "${PROFILE_NAME}": ${profile
    ? `${profile.attributes.profileType}, ${profile.attributes.profileState}, expires ${profile.attributes.expirationDate.slice(0, 10)}`
    : 'not created yet'}`);

if (app) {
    const builds = await api(`/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,uploadedDate,expired`);
    console.log(`Builds (newest first): ${builds.data.length ? '' : 'none yet'}`);
    for (const b of builds.data) {
        console.log(`  build ${b.attributes.version}: ${b.attributes.processingState}, uploaded ${new Date(b.attributes.uploadedDate).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    }
}
