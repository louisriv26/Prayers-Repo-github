import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = [
  'index.html', 'styles.css', 'app.js', 'sw.js', 'sw.template.js', 'manifest.webmanifest',
  'data/prayers.json', 'data/prayers.js', 'data/help.json', 'data/help.js', 'release.json',
  'tools/generate_corpus_js.py', 'tools/generate_help_js.py', 'tools/generate_sw.py',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
];
const runtimeInputs = [
  'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'data/prayers.json', 'data/prayers.js', 'data/help.json', 'data/help.js', 'release.json', 'icons/icon.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'sw.template.js'
];
const coreAssets = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './data/prayers.json', './data/prayers.js', './data/help.json', './data/help.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'
];
const failures = [];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`Fichier requis absent : ${file}`);
}

function parseWindowBundle(source, name) {
  const match = source.match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*);\\s*$`));
  if (!match) throw new Error(`Le bundle ${name} ne peut pas être analysé.`);
  return JSON.parse(match[1]);
}

const corpus = JSON.parse(fs.readFileSync(path.join(root, 'data/prayers.json'), 'utf8'));
try {
  const bundle = parseWindowBundle(fs.readFileSync(path.join(root, 'data/prayers.js'), 'utf8'), 'PRAYER_CORPUS');
  if (JSON.stringify(bundle) !== JSON.stringify(corpus)) failures.push('Le corpus navigateur diffère du corpus JSON canonique. Régénérez data/prayers.js.');
} catch (error) { failures.push(error.message); }

const help = JSON.parse(fs.readFileSync(path.join(root, 'data/help.json'), 'utf8'));
try {
  const bundle = parseWindowBundle(fs.readFileSync(path.join(root, 'data/help.js'), 'utf8'), 'APP_HELP');
  if (JSON.stringify(bundle) !== JSON.stringify(help)) failures.push('L’aide navigateur diffère de data/help.json. Régénérez data/help.js.');
} catch (error) { failures.push(error.message); }

const releaseMetadata = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
if (releaseMetadata.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(String(releaseMetadata.version || '')) || !/^\d+\.\d+\.\d+-help-audited-prototype$/.test(String(releaseMetadata.appVersion || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(releaseMetadata.publishedAt || '')) || !String(releaseMetadata.releaseNotes || '').trim()) failures.push('release.json est invalide.');
const packageForRelease = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (releaseMetadata.version !== packageForRelease.version || releaseMetadata.appVersion !== `${packageForRelease.version}-help-audited-prototype`) failures.push('release.json ne correspond pas à package.json.');

if (!Array.isArray(corpus.prayers) || corpus.prayers.length < 1) failures.push('Corpus vide ou invalide.');
const ids = new Set();
for (const prayer of corpus.prayers) {
  if (!prayer.id || !/^[a-z0-9_]+$/.test(prayer.id)) failures.push(`Identifiant invalide : ${prayer.id}`);
  if (ids.has(prayer.id)) failures.push(`Identifiant dupliqué : ${prayer.id}`);
  ids.add(prayer.id);
  if (!prayer.title?.trim()) failures.push(`Titre absent : ${prayer.id}`);
  if (!Array.isArray(prayer.categories) || prayer.categories.length === 0 || prayer.categories.some(category => !String(category).trim())) failures.push(`Catégorie absente ou invalide : ${prayer.id}`);
  if (!Array.isArray(prayer.keywords)) failures.push(`Mots-clés absents : ${prayer.id}`);
  if (!Array.isArray(prayer.blocks) || prayer.blocks.length === 0) failures.push(`Texte absent : ${prayer.id}`);
  if (!prayer.source?.trim() || !prayer.sourceStatus?.trim()) failures.push(`Métadonnées éditoriales incomplètes : ${prayer.id}`);
  prayer.blocks.forEach((block, index) => {
    if (!block || !['line', 'quote', 'spacer'].includes(block.type)) failures.push(`Type de bloc non reconnu (${prayer.id}, ${index})`);
    if (block?.type !== 'spacer' && !block?.text?.trim()) failures.push(`Texte de bloc absent (${prayer.id}, ${index})`);
    if (block?.emphasis && block.emphasis !== 'strong') failures.push(`Emphase non reconnue (${prayer.id}, ${index})`);
  });
}

if (help.helpVersion !== '1.0.0' || help.language !== 'fr' || !help.title?.trim()) failures.push('Métadonnées de l’aide invalides.');
if (!Array.isArray(help.sections) || help.sections.length < 10) failures.push('Aide incomplète : au moins dix sections sont requises.');
const helpIds = new Set();
const helpBlockTypes = new Set(['paragraph', 'bullets', 'steps', 'notice']);
for (const section of help.sections || []) {
  if (!section?.id || !/^[a-z0-9-]+$/.test(section.id) || !section.title?.trim() || !Array.isArray(section.blocks)) {
    failures.push(`Section d’aide invalide : ${section?.id || 'sans identifiant'}`);
    continue;
  }
  if (helpIds.has(section.id)) failures.push(`Identifiant de section d’aide dupliqué : ${section.id}`);
  helpIds.add(section.id);
  for (const block of section.blocks) {
    if (!block || !helpBlockTypes.has(block.type)) failures.push(`Type de bloc d’aide invalide : ${section.id}`);
    if (block?.type === 'paragraph' && !String(block.text || '').trim()) failures.push(`Texte de paragraphe d’aide absent : ${section.id}`);
    if ((block?.type === 'bullets' || block?.type === 'steps') && (!Array.isArray(block.items) || !block.items.length || block.items.some(item => !String(item).trim()))) failures.push(`Liste d’aide invalide : ${section.id}`);
    if (block?.type === 'notice' && (!String(block.label || '').trim() || !String(block.text || '').trim())) failures.push(`Encadré d’aide invalide : ${section.id}`);
  }
}
for (const requiredId of ['essentiel', 'demarrer', 'listes', 'organiser', 'repertoire', 'lecture', 'reglages', 'sauvegarde', 'installation', 'contenu-confidentialite', 'depannage', 'limites']) {
  if (!helpIds.has(requiredId)) failures.push(`Section d’aide requise absente : ${requiredId}`);
}
const helpText = JSON.stringify(help);
for (const forbidden of ['diffusion publique approuvée', 'vérifications matérielles sont accomplies', 'synchronisation automatique entre votre téléphone']) {
  if (helpText.includes(forbidden)) failures.push(`Claim d’aide interdit ou contradictoire : ${forbidden}`);
}
for (const requiredPhrase of ['prototype privé', 'ne synchronise pas automatiquement', 'À valider', 'doit encore être vérifié']) {
  if (!helpText.includes(requiredPhrase)) failures.push(`Limite d’aide requise absente : ${requiredPhrase}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const hash = crypto.createHash('sha256');
for (const relative of runtimeInputs) {
  hash.update(relative, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(fs.readFileSync(path.join(root, relative)));
  hash.update('\0', 'utf8');
}
const expectedCacheVersion = `mes-prieres-pwa-prototype-v${packageJson.version}-audited-${hash.digest('hex').slice(0, 12)}`;
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const cacheMatch = sw.match(/const CACHE_VERSION = '([^']+)';/);
if (!cacheMatch || cacheMatch[1] !== expectedCacheVersion) failures.push(`Version de cache service worker incohérente : attendu ${expectedCacheVersion}`);
if (!sw.includes("const CACHE_PREFIX = 'mes-prieres-pwa-prototype-';")) failures.push('Service worker sans espace de noms de cache strictement applicatif.');
if (!sw.includes('const LEGACY_CACHE_PATTERN = /^mes-prieres-v\\d+\\.\\d+\\.\\d+-audited-[0-9a-f]{12}$/;')) failures.push('Service worker sans migration de cache legacy strictement bornée.');
if (!sw.includes('(key.startsWith(CACHE_PREFIX) || LEGACY_CACHE_PATTERN.test(key)) && key !== CACHE_VERSION')) failures.push('Service worker peut supprimer des caches extérieurs à cette application.');
if (!sw.includes('const cache = await caches.open(CACHE_VERSION);') || !sw.includes('const cached = await cache.match(event.request);') || sw.includes('caches.match(event.request)')) failures.push('Service worker ne limite pas ses lectures au cache actif de cette application.');
for (const asset of coreAssets) if (!sw.includes(`'${asset}'`)) failures.push(`Asset hors ligne absent du service worker : ${asset}`);
if (!sw.includes('response && response.ok')) failures.push('Service worker peut mettre en cache une réponse non réussie.');
if (!sw.includes("event.data && event.data.type === 'SKIP_WAITING'") || !sw.includes('self.skipWaiting()')) failures.push('Service worker sans activation explicitement initiée par l’utilisateur.');
if (!sw.includes("requestUrl.pathname.endsWith('/release.json')") || !sw.includes('event.respondWith(fetch(event.request)); return;')) failures.push('release.json doit être vérifié sur le réseau et ne pas être servi depuis le cache PWA.');
if (coreAssets.includes('./release.json')) failures.push('release.json ne doit pas être précaché.');

const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
for (const mustContain of [
  'onboardingComplete', 'exportState', 'importState', 'serviceWorker',
  'addPrayerToList', 'openOrganizeModal', 'indexedDB', 'writeStateToDatabase',
  'moveList', 'saveAutomaticBackup', 'restoreAutomaticBackup', 'validateImportedState',
  'checkForUpdates', 'installAvailableUpdate', 'renderVersionFooter', 'RELEASE_METADATA_PATH', 'SKIP_WAITING',
  'await persistenceQueue.catch', "event.key !== 'Tab'", 'readerScrollY', 'window.APP_HELP', 'validateHelp', 'renderHelp', 'openHelp', 'helpBack', 'data-action="open-help"'
]) {
  if (!appJs.includes(mustContain)) failures.push(`Capacité obligatoire non trouvée dans app.js : ${mustContain}`);
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const asset of ['styles.css', 'data/prayers.js', 'data/help.js', 'app.js', 'manifest.webmanifest']) {
  if (!html.includes(asset)) failures.push(`index.html ne référence pas : ${asset}`);
}
if (html.includes('id="app" class="app-shell" aria-live="polite"')) failures.push('La zone racine de l’application ne doit pas être une région aria-live globale.');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
for (const key of ['id', 'scope', 'start_url', 'display']) if (!manifest[key]) failures.push(`Manifest PWA incomplet : ${key}`);
for (const icon of manifest.icons || []) {
  if (!icon.src || !fs.existsSync(path.join(root, icon.src))) failures.push(`Icône manifest absente : ${icon.src}`);
}

if (failures.length) {
  console.error('AUDIT: FAIL');
  failures.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}
console.log('AUDIT: PASS');
console.log(`Corpus: ${corpus.prayers.length} prières complètes`);
console.log(`Aide: ${help.sections.length} sections`);
console.log(`Version: ${corpus.corpusVersion}`);
console.log(`Service-worker cache: ${expectedCacheVersion}`);
