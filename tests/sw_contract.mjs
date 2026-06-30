/* Service-worker behavioral contract test, run without a network-enabled browser. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const listeners = new Map();
const calls = { addAll: [], deleted: [], fetched: 0, put: [], opened: [], skipWaiting: 0 };
let activeCacheMatchValue = null;
let nextNetworkResponse = null;
const activeVersion = source.match(/const CACHE_VERSION = '([^']+)'/)[1];
const caches = {
  async open(name) {
    calls.opened.push(name);
    assert.equal(name, activeVersion);
    return {
      async addAll(assets) { calls.addAll.push([...assets]); },
      async match() { return activeCacheMatchValue; },
      async put(request, response) { calls.put.push({ request, response }); },
    };
  },
  async keys() { return ['unrelated-cache', 'priere-other-app', 'mes-prieres-neighbour-app-v1', 'mes-prieres-pwa-prototype-v0.0.0-audited-old', 'mes-prieres-v0.1.4-audited-ae7bdf7f6f91', activeVersion]; },
  async delete(name) { calls.deleted.push(name); return true; },
  async match() { throw new Error('Global caches.match() must not be used by this PWA.'); },
};
const context = {
  self: {
    location: { origin: 'https://app.test' },
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: () => { calls.skipWaiting += 1; },
  },
  caches,
  URL,
  fetch: async request => {
    calls.fetched += 1;
    return nextNetworkResponse ?? { ok: true, request, clone() { return { cloned: true }; } };
  },
};
vm.runInNewContext(source, context, { filename: 'sw.js' });
assert.deepEqual([...listeners.keys()].sort(), ['activate', 'fetch', 'install', 'message']);
assert.match(source, /self\.addEventListener\('message'/);
assert.match(source, /event\.data\.type === 'SKIP_WAITING'/);
assert.match(activeVersion, new RegExp(`^mes-prieres-pwa-prototype-v${packageJson.version.replaceAll('.', '\\.')}-audited-[0-9a-f]{12}$`));
assert.match(source, /const CACHE_PREFIX = 'mes-prieres-pwa-prototype-';/);
assert.ok(source.includes("const LEGACY_CACHE_PATTERN = /^mes-prieres-v\\d+\\.\\d+\\.\\d+-audited-[0-9a-f]{12}$/;"));
assert.match(source, /const cache = await caches\.open\(CACHE_VERSION\);/);
assert.match(source, /const cached = await cache\.match\(event\.request\);/);
assert.doesNotMatch(source, /caches\.match\(event\.request\)/);
assert.match(source, /requestUrl\.pathname\.endsWith\('\/release\.json'\)/);

listeners.get('message')({ data: { type: 'IGNORE' } });
assert.equal(calls.skipWaiting, 0);
listeners.get('message')({ data: { type: 'SKIP_WAITING' } });
assert.equal(calls.skipWaiting, 1);

const install = { waitUntil(promise) { this.promise = promise; } };
listeners.get('install')(install);
await install.promise;
assert.deepEqual(calls.addAll[0], [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './data/prayers.json', './data/prayers.js', './data/help.json', './data/help.js', './icons/icon.svg',
  './icons/icon-192.png', './icons/icon-512.png'
]);
assert.equal(calls.addAll[0].includes('./release.json'), false, 'release metadata must remain network-only.');

const activate = { waitUntil(promise) { this.promise = promise; } };
listeners.get('activate')(activate);
await activate.promise;
assert.deepEqual(calls.deleted, ['mes-prieres-pwa-prototype-v0.0.0-audited-old', 'mes-prieres-v0.1.4-audited-ae7bdf7f6f91']);
assert.equal(calls.deleted.includes('mes-prieres-neighbour-app-v1'), false, 'A sibling same-origin cache must not be purged merely because it starts with mes-prieres-.');

activeCacheMatchValue = { cached: true };
const cachedEvent = { request: { method: 'GET', url: 'https://app.test/index.html' }, waitUntil(promise) { (this.promises ??= []).push(promise); }, respondWith(promise) { this.response = promise; } };
listeners.get('fetch')(cachedEvent);
assert.deepEqual(await cachedEvent.response, { cached: true });
assert.equal(calls.fetched, 0);

activeCacheMatchValue = null;
nextNetworkResponse = { ok: true, clone() { return { cloned: true }; } };
const missEvent = { request: { method: 'GET', url: 'https://app.test/new-file.js' }, waitUntil(promise) { (this.promises ??= []).push(promise); }, respondWith(promise) { this.response = promise; } };
listeners.get('fetch')(missEvent);
const networkResponse = await missEvent.response;
assert.equal(networkResponse.ok, true);
await Promise.all(missEvent.promises ?? []);
assert.equal(calls.fetched, 1);
assert.equal(calls.put.length, 1);

const beforeReleaseFetch = calls.fetched;
const beforeReleasePut = calls.put.length;
nextNetworkResponse = { ok: true, json: async () => ({ version: packageJson.version }), clone() { return { cloned: true }; } };
const releaseEvent = { request: { method: 'GET', url: 'https://app.test/release.json?_update=1' }, respondWith(promise) { this.response = promise; } };
listeners.get('fetch')(releaseEvent);
assert.equal((await releaseEvent.response).ok, true);
assert.equal(calls.fetched, beforeReleaseFetch + 1, 'release metadata must go to the network.');
assert.equal(calls.put.length, beforeReleasePut, 'release metadata must not be cached.');

activeCacheMatchValue = null;
nextNetworkResponse = { ok: false, status: 503, clone() { return { cloned: true }; } };
const failedResponseEvent = { request: { method: 'GET', url: 'https://app.test/unavailable.json' }, waitUntil(promise) { (this.promises ??= []).push(promise); }, respondWith(promise) { this.response = promise; } };
listeners.get('fetch')(failedResponseEvent);
assert.equal((await failedResponseEvent.response).status, 503);
await Promise.all(failedResponseEvent.promises ?? []);
assert.equal(calls.put.length, beforeReleasePut, 'A non-success response must not be cached.');

const externalEvent = { request: { method: 'GET', url: 'https://other.test/file.js' }, respondWith(promise) { this.response = promise; } };
listeners.get('fetch')(externalEvent);
assert.equal(externalEvent.response, undefined, 'Cross-origin requests must not be intercepted.');
const postEvent = { request: { method: 'POST', url: 'https://app.test/state' }, respondWith(promise) { this.response = promise; } };
listeners.get('fetch')(postEvent);
assert.equal(postEvent.response, undefined, 'Non-GET requests must not be intercepted.');

console.log('SW_CONTRACT: PASS');
