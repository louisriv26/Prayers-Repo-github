(() => {
  'use strict';

  const APP_RELEASE_VERSION = '0.1.6';
  const APP_VERSION = '0.1.6-help-audited-prototype';
  const RELEASE_METADATA_PATH = './release.json';
  const UPDATE_CHECK_TIMEOUT_MS = 7000;
  const STORAGE_KEY = 'mes-prieres.state.v1';
  const BACKUP_STORAGE_KEY = 'mes-prieres.backup.v1';
  const DB_NAME = 'mes-prieres';
  const DB_VERSION = 1;
  const DB_STORE = 'state';
  const DB_KEY = 'current';
  const DB_BACKUP_KEY = 'automatic-backup';
  const SCHEMA_VERSION = 1;
  const DEFAULT_SUGGESTED_IDS = [
    'priere_oui_aujourdhui',
    'priere_saint_michel',
    'priere_infusion_divine_volonte',
    'ame_du_christ'
  ];

  const app = document.getElementById('app');
  let corpus = null;
  let help = null;
  let state = null;
  let view = { page: 'mine', activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null, helpReturn: null };
  let wakeLock = null;
  let persistenceQueue = Promise.resolve();
  let serviceWorkerRegistration = null;
  let updateCheckPromise = null;
  let reloadAfterServiceWorkerUpdate = false;
  let updateState = { status: 'unchecked', latest: null, checkedAt: null, error: null };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const escapeHtml = text => String(text).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const norm = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const cloneValue = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

  async function init() {
    try {
      corpus = window.PRAYER_CORPUS;
      help = window.APP_HELP;
      validateCorpus(corpus);
      validateHelp(help);
      state = await loadState();
      applyTheme();
      const serviceWorkerReady = registerServiceWorker();
      render();
      serviceWorkerReady.finally(() => {
        window.setTimeout(() => { checkForUpdates({ userInitiated: false }); }, 350);
      });
    } catch (error) {
      console.error(error);
      app.innerHTML = `<main class="app-main"><section class="empty-state"><div><h1>Impossible de charger l’application</h1><p class="subtle">${escapeHtml(error.message)}</p><button class="button primary" type="button" onclick="location.reload()">Réessayer</button></div></section></main>`;
    }
  }

  function validateCorpus(data) {
    if (!data || !Array.isArray(data.prayers)) throw new Error('Format de corpus invalide.');
    const seen = new Set();
    data.prayers.forEach(prayer => {
      if (!prayer.id || !prayer.title || !Array.isArray(prayer.blocks)) throw new Error('Une prière ne respecte pas le schéma minimal.');
      if (seen.has(prayer.id)) throw new Error(`Identifiant de prière dupliqué : ${prayer.id}`);
      seen.add(prayer.id);
    });
  }

  function validateHelp(data) {
    if (!data || typeof data !== 'object' || !data.title || !Array.isArray(data.sections)) throw new Error('Format de l’aide invalide.');
    const seen = new Set();
    const allowed = new Set(['paragraph', 'bullets', 'steps', 'notice']);
    data.sections.forEach(section => {
      if (!section || !/^[a-z0-9-]+$/.test(section.id || '') || !section.title || !Array.isArray(section.blocks)) throw new Error('Une section d’aide ne respecte pas le schéma minimal.');
      if (seen.has(section.id)) throw new Error(`Identifiant de section d’aide dupliqué : ${section.id}`);
      seen.add(section.id);
      section.blocks.forEach(block => {
        if (!block || !allowed.has(block.type)) throw new Error(`Type de bloc d’aide invalide : ${section.id}`);
        if (block.type === 'paragraph' && !String(block.text || '').trim()) throw new Error(`Texte d’aide absent : ${section.id}`);
        if ((block.type === 'bullets' || block.type === 'steps') && (!Array.isArray(block.items) || !block.items.length || block.items.some(item => !String(item).trim()))) throw new Error(`Liste d’aide invalide : ${section.id}`);
        if (block.type === 'notice' && (!String(block.label || '').trim() || !String(block.text || '').trim())) throw new Error(`Encadré d’aide invalide : ${section.id}`);
      });
    });
  }

  function createInitialState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      onboardingComplete: false,
      lists: [],
      listItems: [],
      settings: { theme: 'system', fontScale: 1, lineHeight: 1.72, keepScreenAwake: false },
      lastRead: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async function openDatabase() {
    if (!('indexedDB' in window)) return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readStateFromDatabase(key = DB_KEY) {
    const db = await openDatabase();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      request.onsuccess = () => { db.close(); resolve(request.result || null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }

  async function writeStateToDatabase(value, key = DB_KEY) {
    const db = await openDatabase();
    if (!db) return false;
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(value, key);
      request.onsuccess = () => { db.close(); resolve(true); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }

  async function clearStateFromDatabase(key = DB_KEY) {
    const db = await openDatabase();
    if (!db) return false;
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(key);
      request.onsuccess = () => { db.close(); resolve(true); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }

  function readLocalJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn('Copie locale illisible.', error);
      return null;
    }
  }

  function writeLocalJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn('Copie locale indisponible.', error);
      return false;
    }
  }

  function removeLocalValue(key) {
    try { localStorage.removeItem(key); return true; } catch (error) { console.warn('Effacement local impossible.', error); return false; }
  }

  function isUsablePersistedState(candidate) {
    return Boolean(
      candidate
      && candidate.schemaVersion === SCHEMA_VERSION
      && Array.isArray(candidate.lists)
      && Array.isArray(candidate.listItems)
      && candidate.settings
      && typeof candidate.settings === 'object'
    );
  }

  function newestUsableState(candidates) {
    const usable = candidates.filter(isUsablePersistedState);
    if (!usable.length) return null;
    return usable.sort((left, right) => {
      const leftDate = Date.parse(left.updatedAt || '') || 0;
      const rightDate = Date.parse(right.updatedAt || '') || 0;
      // Keep the synchronous local mirror as the tie-breaker when timestamps are equal.
      if (leftDate === rightDate) return candidates.indexOf(left) - candidates.indexOf(right);
      return rightDate - leftDate;
    })[0];
  }

  async function loadState() {
    let databaseState = null;
    try {
      databaseState = await readStateFromDatabase();
    } catch (error) {
      console.warn('IndexedDB indisponible; utilisation de la copie locale.', error);
    }
    const localState = readLocalJson(STORAGE_KEY);
    const parsed = newestUsableState([localState, databaseState]);
    return parsed ? sanitizeState(parsed) : createInitialState();
  }

  function sanitizeState(candidate) {
    const base = createInitialState();
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    const prayerIds = new Set(corpus.prayers.map(prayer => prayer.id));
    const rawLists = Array.isArray(source.lists) ? source.lists : [];
    const seenListIds = new Set();
    const lists = [];
    rawLists.forEach((rawList, originalIndex) => {
      if (!rawList || typeof rawList !== 'object') return;
      const id = typeof rawList.id === 'string' ? rawList.id.trim() : '';
      if (!id || seenListIds.has(id)) return;
      seenListIds.add(id);
      const title = typeof rawList.title === 'string' && rawList.title.trim() ? rawList.title.trim().slice(0, 60) : 'Liste sans nom';
      const position = Number.isFinite(rawList.position) ? rawList.position : originalIndex;
      lists.push({
        id,
        title,
        position,
        isDefault: rawList.isDefault === true,
        createdAt: typeof rawList.createdAt === 'string' ? rawList.createdAt : base.createdAt,
        updatedAt: typeof rawList.updatedAt === 'string' ? rawList.updatedAt : base.updatedAt
      });
    });
    lists.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'fr'));
    lists.forEach((list, index) => { list.position = index; });
    let defaultAssigned = false;
    lists.forEach(list => { list.isDefault = list.isDefault && !defaultAssigned; if (list.isDefault) defaultAssigned = true; });
    if (lists.length && !defaultAssigned) lists[0].isDefault = true;

    const seenItems = new Set();
    const rawItems = Array.isArray(source.listItems) ? source.listItems : [];
    const listItems = [];
    rawItems.forEach((rawItem, originalIndex) => {
      if (!rawItem || typeof rawItem !== 'object') return;
      const listId = typeof rawItem.listId === 'string' ? rawItem.listId : '';
      const prayerId = typeof rawItem.prayerId === 'string' ? rawItem.prayerId : '';
      const key = `${listId}::${prayerId}`;
      if (!seenListIds.has(listId) || !prayerIds.has(prayerId) || seenItems.has(key)) return;
      seenItems.add(key);
      listItems.push({
        id: typeof rawItem.id === 'string' && rawItem.id ? rawItem.id : uid('item'),
        listId,
        prayerId,
        position: Number.isFinite(rawItem.position) ? rawItem.position : originalIndex
      });
    });
    lists.forEach(list => {
      const own = listItems.filter(item => item.listId === list.id).sort((a, b) => a.position - b.position || a.prayerId.localeCompare(b.prayerId, 'fr'));
      own.forEach((item, index) => { item.position = index; });
    });

    const allowedThemes = new Set(['system', 'light', 'dark']);
    const allowedFontScales = new Set([.9, 1, 1.15, 1.3]);
    const allowedLineHeights = new Set([1.55, 1.72, 1.9]);
    const rawSettings = source.settings && typeof source.settings === 'object' ? source.settings : {};
    const settings = {
      theme: allowedThemes.has(rawSettings.theme) ? rawSettings.theme : base.settings.theme,
      fontScale: allowedFontScales.has(Number(rawSettings.fontScale)) ? Number(rawSettings.fontScale) : base.settings.fontScale,
      lineHeight: allowedLineHeights.has(Number(rawSettings.lineHeight)) ? Number(rawSettings.lineHeight) : base.settings.lineHeight,
      keepScreenAwake: rawSettings.keepScreenAwake === true
    };
    const lastRead = {};
    const rawLastRead = source.lastRead && typeof source.lastRead === 'object' ? source.lastRead : {};
    Object.entries(rawLastRead).forEach(([prayerId, value]) => { if (prayerIds.has(prayerId) && Number.isFinite(value) && value >= 0) lastRead[prayerId] = value; });

    return {
      ...base,
      schemaVersion: SCHEMA_VERSION,
      onboardingComplete: source.onboardingComplete === true,
      lists,
      listItems,
      settings,
      lastRead,
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : base.createdAt,
      updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : base.updatedAt
    };
  }

  function validateImportedState(candidate) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Ce fichier ne contient pas une configuration reconnue.');
    if (candidate.schemaVersion !== SCHEMA_VERSION) throw new Error(`Version de sauvegarde incompatible (attendue : ${SCHEMA_VERSION}).`);
    if (!Array.isArray(candidate.lists) || !Array.isArray(candidate.listItems)) throw new Error('Ce fichier ne contient pas les listes attendues.');
  }

  async function saveAutomaticBackup(reason) {
    const payload = { savedAt: new Date().toISOString(), reason, schemaVersion: SCHEMA_VERSION, state: cloneValue(state) };
    const localSaved = writeLocalJson(BACKUP_STORAGE_KEY, payload);
    let databaseSaved = false;
    try { databaseSaved = await writeStateToDatabase(payload, DB_BACKUP_KEY); } catch (error) { console.warn('Sauvegarde IndexedDB automatique impossible.', error); }
    if (!localSaved && !databaseSaved) throw new Error('Sauvegarde automatique impossible dans ce navigateur.');
    return payload;
  }

  async function loadAutomaticBackup() {
    let databaseBackup = null;
    try { databaseBackup = await readStateFromDatabase(DB_BACKUP_KEY); } catch (error) { console.warn('Sauvegarde IndexedDB indisponible.', error); }
    const localBackup = readLocalJson(BACKUP_STORAGE_KEY);
    const candidates = [localBackup, databaseBackup]
      .filter(candidate => candidate?.state)
      .sort((left, right) => {
        const leftDate = Date.parse(left.savedAt || '') || 0;
        const rightDate = Date.parse(right.savedAt || '') || 0;
        return rightDate - leftDate;
      });
    for (const candidate of candidates) {
      try {
        validateImportedState(candidate.state);
        return candidate;
      } catch (_) {
        // A newer corrupt mirror must not hide an older valid backup.
      }
    }
    return null;
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    const snapshot = cloneValue(state);
    // localStorage is retained as a fallback mirror for browsers where IndexedDB fails.
    writeLocalJson(STORAGE_KEY, snapshot);
    // Serialising writes prevents an older asynchronous transaction from overwriting newer choices.
    persistenceQueue = persistenceQueue
      .catch(() => undefined)
      .then(() => writeStateToDatabase(snapshot))
      .catch(error => console.warn('Sauvegarde IndexedDB impossible.', error));
    applyTheme();
    return persistenceQueue;
  }

  function applyTheme() {
    const preference = state?.settings?.theme || 'system';
    const isDark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--font-scale', state?.settings?.fontScale || 1);
    document.documentElement.style.setProperty('--reader-line-height', state?.settings?.lineHeight || 1.72);
  }

  function getPrayer(id) { return corpus.prayers.find(prayer => prayer.id === id) || null; }
  function orderedLists() { return [...state.lists].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'fr')); }
  function getDefaultList() { return orderedLists().find(list => list.isDefault) || orderedLists()[0] || null; }
  function getList(id) { return state.lists.find(list => list.id === id) || null; }
  function getListItems(listId) { return state.listItems.filter(item => item.listId === listId).sort((a, b) => a.position - b.position); }
  function getPrayerListItems(listId) { return getListItems(listId).map(item => ({ item, prayer: getPrayer(item.prayerId) })).filter(record => record.prayer); }
  function getListsContainingPrayer(prayerId) { return orderedLists().filter(list => state.listItems.some(item => item.listId === list.id && item.prayerId === prayerId)); }

  function compareReleaseVersions(left, right) {
    const parse = value => {
      const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!match) throw new Error('Format de version invalide.');
      return match.slice(1).map(Number);
    };
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function validateReleaseMetadata(candidate) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Informations de version invalides.');
    if (!/^\d+\.\d+\.\d+$/.test(String(candidate.version || ''))) throw new Error('Version disponible invalide.');
    if (!/^\d+\.\d+\.\d+-help-audited-prototype$/.test(String(candidate.appVersion || ''))) throw new Error('Identité applicative disponible invalide.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(candidate.publishedAt || ''))) throw new Error('Date de publication invalide.');
    if (typeof candidate.releaseNotes !== 'string' || !candidate.releaseNotes.trim()) throw new Error('Notes de version absentes.');
    return candidate;
  }

  function updateSummaryText() {
    if (updateState.status === 'checking') return 'Vérification…';
    if (updateState.status === 'current') return 'À jour';
    if (updateState.status === 'available') return `Mise à jour v${updateState.latest.version} disponible`;
    if (updateState.status === 'installing') return 'Installation en cours…';
    if (updateState.status === 'newer-local') return 'Version locale plus récente';
    if (updateState.status === 'unavailable') return 'Vérification indisponible';
    return 'Vérifier les mises à jour';
  }

  function formatCheckTime(value) {
    if (!value) return '';
    try { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(value); } catch (_) { return ''; }
  }

  function renderVersionFooter() {
    return `<footer class="version-footer" aria-label="Version de l’application"><span>Version <strong>v${APP_RELEASE_VERSION}</strong> · Corpus ${escapeHtml(corpus.corpusVersion)}</span><span class="version-state" data-update-summary>${escapeHtml(updateSummaryText())}</span><button class="text-button" type="button" data-action="open-settings">Mises à jour</button></footer>`;
  }

  function renderUpdatePanel() {
    const checkedAt = formatCheckTime(updateState.checkedAt);
    let detail = 'Vérifiez la version disponible lorsque vous êtes connecté à Internet.';
    if (updateState.status === 'checking') detail = 'Vérification de la version disponible…';
    if (updateState.status === 'current') detail = `À jour : v${APP_RELEASE_VERSION} correspond à la version actuellement accessible${checkedAt ? ` (vérifiée à ${checkedAt})` : ''}.`;
    if (updateState.status === 'available') detail = `Mise à jour disponible : v${updateState.latest.version}, publiée le ${updateState.latest.publishedAt}. ${updateState.latest.releaseNotes}`;
    if (updateState.status === 'installing') detail = 'La mise à jour est en cours de préparation. L’application se rechargera une fois la nouvelle version activée.';
    if (updateState.status === 'newer-local') detail = `Cette installation (v${APP_RELEASE_VERSION}) est plus récente que la version actuellement accessible (v${updateState.latest.version}).`;
    if (updateState.status === 'unavailable') detail = `Impossible de vérifier une nouvelle version${updateState.error ? ` : ${updateState.error}` : ''}.`;
    return `<p class="subtle update-detail" data-update-details>${escapeHtml(detail)}</p><div class="button-row"><button class="button" type="button" data-action="check-for-updates" ${updateState.status === 'checking' || updateState.status === 'installing' ? 'disabled' : ''}>${updateState.status === 'checking' ? 'Vérification…' : 'Vérifier les mises à jour'}</button>${updateState.status === 'available' ? `<button class="button primary" type="button" data-action="install-update">Installer la mise à jour v${escapeHtml(updateState.latest.version)}</button>` : ''}</div>`;
  }

  function refreshUpdateIndicators() {
    $$('[data-update-summary]').forEach(node => { node.textContent = updateSummaryText(); });
    $$('[data-update-panel]').forEach(node => { node.innerHTML = renderUpdatePanel(); });
  }

  function releaseMetadataRequestUrl() {
    try {
      const current = new URL(window.location.href);
      if (current.protocol === 'about:') throw new Error('test document');
      const fallbackScope = new URL(current.href);
      if (fallbackScope.pathname.endsWith('/index.html')) fallbackScope.pathname = fallbackScope.pathname.slice(0, -'index.html'.length);
      else if (!fallbackScope.pathname.endsWith('/')) fallbackScope.pathname = `${fallbackScope.pathname}/`;
      const base = serviceWorkerRegistration?.scope || fallbackScope.href;
      const url = new URL('release.json', base);
      url.searchParams.set('_update', String(Date.now()));
      return url.toString();
    } catch (_) {
      return `${RELEASE_METADATA_PATH}?_update=${Date.now()}`;
    }
  }

  async function fetchLatestReleaseMetadata() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? window.setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS) : null;
    try {
      const response = await fetch(releaseMetadataRequestUrl(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller?.signal
      });
      if (!response.ok) throw new Error(`réponse réseau ${response.status}`);
      return validateReleaseMetadata(await response.json());
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('délai de vérification dépassé');
      throw error;
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
  }

  async function checkForUpdates({ userInitiated = false } = {}) {
    if (updateCheckPromise) return updateCheckPromise;
    updateState = { ...updateState, status: 'checking', error: null };
    refreshUpdateIndicators();
    updateCheckPromise = (async () => {
      try {
        const latest = await fetchLatestReleaseMetadata();
        const comparison = compareReleaseVersions(latest.version, APP_RELEASE_VERSION);
        updateState = { status: comparison > 0 ? 'available' : comparison === 0 ? 'current' : 'newer-local', latest, checkedAt: new Date(), error: null };
        if (userInitiated) toast(comparison > 0 ? `La version v${latest.version} est disponible.` : comparison === 0 ? 'Cette application est à jour.' : 'Cette installation est plus récente que la version actuellement accessible.');
      } catch (error) {
        updateState = { ...updateState, status: 'unavailable', checkedAt: new Date(), error: error?.message || 'erreur inconnue' };
        if (userInitiated) toast('Impossible de vérifier les mises à jour.');
      } finally {
        updateCheckPromise = null;
        refreshUpdateIndicators();
      }
      return updateState;
    })();
    return updateCheckPromise;
  }

  function observeServiceWorkerUpdate(registration) {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) refreshUpdateIndicators();
    });
  }

  function waitForWaitingWorker(registration, timeoutMs = UPDATE_CHECK_TIMEOUT_MS) {
    if (registration.waiting) return Promise.resolve(registration.waiting);
    return new Promise(resolve => {
      let settled = false;
      const finish = worker => {
        if (settled) return;
        settled = true;
        registration.removeEventListener?.('updatefound', onUpdateFound);
        window.clearTimeout(timer);
        resolve(worker || registration.waiting || null);
      };
      const watchInstalling = worker => {
        if (!worker) return;
        worker.addEventListener('statechange', () => { if (worker.state === 'installed') finish(registration.waiting || worker); });
      };
      const onUpdateFound = () => watchInstalling(registration.installing);
      registration.addEventListener?.('updatefound', onUpdateFound);
      watchInstalling(registration.installing);
      const timer = window.setTimeout(() => finish(registration.waiting), timeoutMs);
    });
  }

  async function installAvailableUpdate() {
    if (updateState.status !== 'available') {
      await checkForUpdates({ userInitiated: true });
      if (updateState.status !== 'available') return;
    }
    updateState = { ...updateState, status: 'installing' };
    refreshUpdateIndicators();
    try {
      const registration = serviceWorkerRegistration || await registerServiceWorker();
      if (!registration) throw new Error('ce navigateur ne prend pas en charge les mises à jour de l’application');
      await registration.update();
      const waitingWorker = await waitForWaitingWorker(registration);
      if (waitingWorker) {
        reloadAfterServiceWorkerUpdate = true;
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        window.setTimeout(() => { if (reloadAfterServiceWorkerUpdate) window.location.reload(); }, UPDATE_CHECK_TIMEOUT_MS);
        return;
      }
      // A reload is an explicit user choice here. It can pick up a freshly active worker or a newly served document.
      window.location.reload();
    } catch (error) {
      updateState = { ...updateState, status: 'available', error: error?.message || 'erreur inconnue' };
      refreshUpdateIndicators();
      toast('Installation de la mise à jour impossible. Réessayez lorsque vous êtes connecté.');
    }
  }

  function render() {
    applyTheme();
    if (!state.onboardingComplete && view.page !== 'help') {
      renderOnboarding();
      return;
    }
    const activeList = getList(view.activeListId) || getDefaultList();
    if (activeList) view.activeListId = activeList.id;
    const page = view.page === 'catalog' ? renderCatalog() : view.page === 'reader' ? renderReader() : view.page === 'help' ? renderHelp() : renderMine();
    const navigation = state.onboardingComplete ? `
      <nav class="bottom-nav" aria-label="Navigation principale">
        <div class="nav-wrap">
          <button class="nav-button" type="button" data-action="go-mine" ${view.page === 'mine' ? 'aria-current="page"' : ''}>${icon('book')}<span>Mes prières</span></button>
          <button class="nav-button" type="button" data-action="go-catalog" ${view.page === 'catalog' ? 'aria-current="page"' : ''}>${icon('search')}<span>Répertoire</span></button>
        </div>
      </nav>` : '';
    app.innerHTML = `
      <header class="app-header">
        <div class="header-row">
          <div class="brand">Mes prières</div>
          <div class="header-actions">
            <button class="icon-button" type="button" data-action="open-help" aria-label="Aide" title="Aide">${icon('help')}</button>
            <button class="icon-button" type="button" data-action="open-settings" aria-label="Réglages" title="Réglages">${icon('settings')}</button>
          </div>
        </div>
      </header>
      <main id="app-main" class="app-main">${page}</main>
      ${navigation}
      <div class="toast-region" aria-live="polite" aria-atomic="true"></div>
    `;
  }

  function renderOnboarding() {
    app.innerHTML = `
      <main id="app-main" class="onboarding">
        <section class="onboarding-card">
          <h1>Votre livre de prières personnel</h1>
          <p class="subtle">Le Répertoire reste commun. Vous décidez des prières que vous voyez, des listes que vous créez et de leur ordre.</p>
          <div class="onboarding-options">
            <button class="button onboarding-option primary" type="button" data-action="onboard-choose"><strong>Choisir mes prières</strong><span>Créez votre première liste et sélectionnez vous-même les prières.</span></button>
            <button class="button onboarding-option" type="button" data-action="onboard-suggested"><strong>Commencer avec une sélection proposée</strong><span>Une courte liste de départ, entièrement modifiable ensuite.</span></button>
            <button class="button onboarding-option" type="button" data-action="onboard-empty"><strong>Commencer avec une liste vide</strong><span>Ajoutez des prières plus tard depuis le Répertoire.</span></button>
          </div>
          <div class="button-row"><button class="button" type="button" data-action="open-help">${icon('help')} Aide</button></div>
          <p class="app-version">Version v${APP_RELEASE_VERSION} · Corpus ${escapeHtml(corpus.corpusVersion)} · <span data-update-summary>${escapeHtml(updateSummaryText())}</span></p>
          <div class="button-row"><button class="text-button" type="button" data-action="open-settings">Mises à jour</button></div>
        </section>
      </main>
    `;
  }

  function renderMine() {
    const activeList = getList(view.activeListId) || getDefaultList();
    if (!activeList) return renderEmptyMain();
    const items = getPrayerListItems(activeList.id);
    return `
      <section>
        <div class="page-title-row">
          <div class="list-switcher">
            <button class="button ghost" type="button" data-action="toggle-list-menu" aria-expanded="${view.activeListMenu ? 'true' : 'false'}">${escapeHtml(activeList.title)} ${icon('chevronDown')}</button>
            ${view.activeListMenu ? renderListMenu(activeList.id) : ''}
          </div>
          <button class="button small" type="button" data-action="organize-list">Organiser</button>
        </div>
        ${items.length ? `<ul class="prayer-list">${items.map(({ item, prayer }) => `
          <li><button class="prayer-card" type="button" data-action="open-prayer" data-prayer-id="${escapeHtml(prayer.id)}" data-context-list-id="${escapeHtml(activeList.id)}">
            <span class="prayer-card-title">${escapeHtml(prayer.title)}</span><span class="arrow">${icon('chevronRight')}</span>
          </button></li>`).join('')}</ul>` : `
          <section class="empty-state"><div><h2>Cette liste est vide</h2><p class="subtle">Ajoutez les prières que vous souhaitez garder à portée de main.</p><button class="button primary" type="button" data-action="go-catalog">Ouvrir le Répertoire</button></div></section>`}
      </section>${renderVersionFooter()}`;
  }

  function renderEmptyMain() {
    return `<section class="empty-state"><div><h1>Créez votre première liste</h1><p class="subtle">Votre espace personnel peut contenir une seule liste ou plusieurs — matin, soir, voyage, protection…</p><button class="button primary" type="button" data-action="organize-list">Créer une liste</button></div></section>`;
  }

  function renderListMenu(activeListId) {
    return `<div class="menu" aria-label="Choisir une liste">${orderedLists().map(list => `<button type="button" data-action="select-list" data-list-id="${escapeHtml(list.id)}"><span>${escapeHtml(list.title)}</span>${list.id === activeListId ? '<span aria-label="Liste active">✓</span>' : ''}</button>`).join('')}<button class="menu-manage" type="button" data-action="organize-list">Gérer mes listes</button></div>`;
  }

  function renderCatalog() {
    const allCategories = ['Toutes', ...[...new Set(corpus.prayers.flatMap(prayer => prayer.categories))].sort((a, b) => a.localeCompare(b, 'fr'))];
    const query = norm(view.catalogQuery);
    const matching = corpus.prayers.filter(prayer => {
      const haystack = norm([prayer.title, ...prayer.categories, ...prayer.keywords, ...prayer.blocks.map(block => block.text || '')].join(' '));
      return (!query || haystack.includes(query)) && (view.catalogCategory === 'Toutes' || prayer.categories.includes(view.catalogCategory));
    });
    return `<section>
      <div class="page-title-row"><div><h1>Répertoire</h1><p class="subtle">Toutes les prières disponibles.</p></div></div>
      <div class="search-box"><input id="catalog-search" type="search" autocomplete="off" placeholder="Rechercher une prière" value="${escapeHtml(view.catalogQuery)}" aria-label="Rechercher une prière"> <span class="search-icon">${icon('search')}</span></div>
      <div class="chips" aria-label="Filtrer par catégorie">${allCategories.map(category => `<button class="chip" type="button" data-action="set-category" data-category="${escapeHtml(category)}" aria-pressed="${view.catalogCategory === category ? 'true' : 'false'}">${escapeHtml(category)}</button>`).join('')}</div>
      <p class="tiny">${matching.length} prière${matching.length !== 1 ? 's' : ''} affichée${matching.length !== 1 ? 's' : ''}</p>
      <ul class="prayer-list">${matching.map(prayer => {
        const lists = getListsContainingPrayer(prayer.id);
        return `<li><button class="prayer-card" type="button" data-action="open-prayer" data-prayer-id="${escapeHtml(prayer.id)}"><span><span class="prayer-card-title">${escapeHtml(prayer.title)}</span><span class="catalog-meta">${prayer.categories.map(category => `<span class="badge">${escapeHtml(category)}</span>`).join('')} ${lists.length ? `<span class="badge in-list">Dans ${lists.length} liste${lists.length > 1 ? 's' : ''}</span>` : ''}</span></span><span class="arrow">${icon('chevronRight')}</span></button></li>`;
      }).join('')}</ul>
      ${matching.length ? '' : `<section class="empty-state"><div><h2>Aucun résultat</h2><p class="subtle">Essayez un autre mot ou retirez le filtre de catégorie.</p><button class="button" type="button" data-action="clear-catalog">Réinitialiser la recherche</button></div></section>`}
      ${renderVersionFooter()}
    </section>`;
  }

  function renderReader() {
    const reader = view.reader;
    const prayer = reader && getPrayer(reader.prayerId);
    if (!prayer) { view.page = 'mine'; return renderMine(); }
    const lists = getListsContainingPrayer(prayer.id);
    const contextItems = reader.contextListId ? getPrayerListItems(reader.contextListId) : [];
    const index = contextItems.findIndex(record => record.prayer.id === prayer.id);
    const prev = index > 0 ? contextItems[index - 1].prayer : null;
    const next = index >= 0 && index < contextItems.length - 1 ? contextItems[index + 1].prayer : null;
    return `<article class="reader">
      <header class="reader-header">
        <button class="button ghost reader-back" type="button" data-action="reader-back">${icon('chevronLeft')} Retour</button>
        <h1 class="reader-title">${escapeHtml(prayer.title)}</h1>
        <div class="catalog-meta">${prayer.categories.map(category => `<span class="badge">${escapeHtml(category)}</span>`).join('')}</div>
      </header>
      <div class="reader-content" data-reader-content>${renderBlocks(prayer.blocks)}</div>
      <div class="reader-actions">
        <button class="button" type="button" data-action="add-prayer-to-lists" data-prayer-id="${escapeHtml(prayer.id)}">${icon('plus')} Ajouter à une liste</button>
      </div>
      ${lists.length ? `<p class="tiny">Dans vos listes : ${lists.map(list => escapeHtml(list.title)).join(' · ')}</p>` : ''}
      <details class="reader-source"><summary>Informations sur le texte</summary><p><strong>Provenance :</strong> ${escapeHtml(prayer.source)}</p><p><strong>Statut éditorial :</strong> ${escapeHtml(prayer.sourceStatus)}</p></details>
      ${reader.contextListId ? `<nav class="reader-nav" aria-label="Navigation dans la liste"><button class="button" type="button" data-action="open-adjacent" data-direction="prev" ${prev ? `data-prayer-id="${escapeHtml(prev.id)}"` : 'disabled'}>${icon('chevronLeft')} ${prev ? escapeHtml(prev.title) : 'Première prière'}</button><button class="button" type="button" data-action="open-adjacent" data-direction="next" ${next ? `data-prayer-id="${escapeHtml(next.id)}"` : 'disabled'}>${next ? escapeHtml(next.title) : 'Dernière prière'} ${icon('chevronRight')}</button></nav>` : ''}
    </article>`;
  }

  function renderHelp() {
    const toc = help.sections.map(section => `<li><a href="#help-${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`).join('');
    const sections = help.sections.map(section => `<section id="help-${escapeHtml(section.id)}" class="help-section" tabindex="-1"><h2>${escapeHtml(section.title)}</h2>${renderHelpBlocks(section.blocks)}</section>`).join('');
    return `<article class="help-page" data-help-page>
      <header class="help-header">
        <button class="button ghost" type="button" data-action="help-back">${icon('chevronLeft')} Retour</button>
        <div><h1>${escapeHtml(help.title)}</h1><p class="subtle">${escapeHtml(help.intro)}</p><p class="tiny">Aide ${escapeHtml(help.helpVersion)} · Application v${APP_RELEASE_VERSION}</p></div>
      </header>
      <nav class="help-toc" aria-label="Sommaire de l’aide"><h2>Sommaire</h2><ol>${toc}</ol></nav>
      <div class="help-sections">${sections}</div>
    </article>`;
  }

  function renderHelpBlocks(blocks) {
    return blocks.map(block => {
      if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`;
      if (block.type === 'bullets') return `<ul class="help-list">${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
      if (block.type === 'steps') return `<ol class="help-list help-steps">${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`;
      if (block.type === 'notice') return `<aside class="help-notice" role="note"><p><strong>${escapeHtml(block.label)}</strong></p><p>${escapeHtml(block.text)}</p></aside>`;
      return '';
    }).join('');
  }

  function openHelp() {
    const readerScrollY = view.page === 'reader' ? Math.max(0, window.scrollY || 0) : 0;
    if (view.page === 'reader' && view.reader?.prayerId) {
      // Preserve both the immediate return point and the durable reading position.
      state.lastRead[view.reader.prayerId] = readerScrollY;
      saveState();
    }
    const helpReturn = {
      page: view.page,
      activeListId: view.activeListId,
      activeListMenu: false,
      catalogQuery: view.catalogQuery,
      catalogCategory: view.catalogCategory,
      reader: view.reader ? cloneValue(view.reader) : null,
      scrollY: readerScrollY
    };
    releaseWakeLock();
    view = { ...view, page: 'help', activeListMenu: false, helpReturn };
    render();
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  function helpBack() {
    const fallback = { page: 'mine', activeListId: getDefaultList()?.id, activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null, scrollY: 0 };
    const previous = view.helpReturn && ['mine', 'catalog', 'reader'].includes(view.helpReturn.page) ? view.helpReturn : fallback;
    view = { ...view, ...previous, activeListMenu: false, helpReturn: null };
    render();
    requestAnimationFrame(() => {
      if (view.page === 'reader') {
        window.scrollTo(0, Number.isFinite(previous.scrollY) ? Math.max(0, previous.scrollY) : 0);
        holdWakeLock();
      }
    });
  }

  function renderBlocks(blocks) {
    return blocks.map(block => {
      if (block.type === 'spacer') return '<div class="spacer" aria-hidden="true"></div>';
      const tag = block.type === 'quote' ? 'blockquote' : 'p';
      const classes = `${block.type || 'line'}${block.emphasis === 'strong' ? ' strong' : ''}`;
      const content = block.emphasis === 'strong' ? `<strong>${escapeHtml(block.text)}</strong>` : escapeHtml(block.text || '');
      return `<${tag} class="${classes}">${content}</${tag}>`;
    }).join('');
  }

  function openModal(title, content, options = {}) {
    closeModal(false);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.dataset.modal = 'true';
    backdrop.__previousFocus = previousFocus;
    backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><button class="icon-button" type="button" data-action="close-modal" aria-label="Fermer">${icon('close')}</button></header>${content}</section>`;
    document.body.append(backdrop);
    const modal = $('.modal', backdrop);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(); });
    backdrop.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
      if (event.key !== 'Tab') return;
      const focusable = $$('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), summary:not([disabled])', modal)
        .filter(element => !element.hidden && element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    const firstFocusable = $('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary:not([disabled])', modal);
    firstFocusable?.focus();
    if (options.onOpen) options.onOpen(backdrop);
  }

  function closeModal(restoreFocus = true) {
    const backdrop = $('[data-modal="true"]');
    if (!backdrop) return;
    const previousFocus = backdrop.__previousFocus;
    backdrop.remove();
    if (restoreFocus && previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus());
  }

  function toast(message) {
    const region = $('.toast-region');
    if (!region) return;
    region.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => { if (region) region.innerHTML = ''; }, 2800);
  }

  function beginOnboarding(mode) {
    if (mode === 'suggested') {
      const list = createList('Mes prières quotidiennes', true);
      DEFAULT_SUGGESTED_IDS.forEach(id => addPrayerToList(id, list.id));
      state.onboardingComplete = true;
      saveState();
      view = { page: 'mine', activeListId: list.id, activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null };
      render();
      toast('Votre liste de départ est prête.');
      return;
    }
    if (mode === 'empty') {
      const list = createList('Mes prières quotidiennes', true);
      state.onboardingComplete = true;
      saveState();
      view = { page: 'mine', activeListId: list.id, activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null };
      render();
      return;
    }
    openChooseFirstListModal();
  }

  function openChooseFirstListModal() {
    const prayerCheckboxes = corpus.prayers.map(prayer => `<label class="check-row"><input type="checkbox" name="initial-prayer" value="${escapeHtml(prayer.id)}"><span>${escapeHtml(prayer.title)}</span></label>`).join('');
    openModal('Choisir mes prières', `<form id="initial-list-form"><div class="form-row"><label for="initial-list-title">Nom de votre première liste</label><input id="initial-list-title" type="text" value="Mes prières quotidiennes" maxlength="60" required></div><div class="modal-section"><p class="subtle">Sélectionnez les prières que vous voulez retrouver facilement. Vous pourrez modifier ce choix à tout moment.</p><div class="check-grid">${prayerCheckboxes}</div></div><div class="button-row"><button class="button primary" type="submit">Créer ma liste</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`);
  }

  function createList(title, isDefault = false) {
    const list = { id: uid('list'), title: title.trim().slice(0, 60) || 'Nouvelle liste', position: orderedLists().length, isDefault: Boolean(isDefault), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (isDefault) state.lists.forEach(item => { item.isDefault = false; });
    state.lists.push(list);
    return list;
  }

  function addPrayerToList(prayerId, listId) {
    if (!getPrayer(prayerId) || !getList(listId)) return false;
    if (state.listItems.some(item => item.prayerId === prayerId && item.listId === listId)) return false;
    state.listItems.push({ id: uid('item'), listId, prayerId, position: getListItems(listId).length });
    return true;
  }

  function removePrayerFromList(prayerId, listId) {
    state.listItems = state.listItems.filter(item => !(item.prayerId === prayerId && item.listId === listId));
    normalizeListPositions(listId);
  }

  function normalizeListPositions(listId) {
    getListItems(listId).forEach((item, index) => { item.position = index; });
  }

  function setDefaultList(listId) {
    state.lists.forEach(list => { list.isDefault = list.id === listId; });
  }

  function deleteList(listId) {
    if (state.lists.length <= 1) {
      toast('Conservez au moins une liste.');
      return false;
    }
    state.lists = state.lists.filter(list => list.id !== listId);
    state.listItems = state.listItems.filter(item => item.listId !== listId);
    orderedLists().forEach((list, index) => { list.position = index; });
    if (!state.lists.some(list => list.isDefault)) state.lists[0].isDefault = true;
    return true;
  }

  function openOrganizeModal(listId = view.activeListId || getDefaultList()?.id) {
    const activeList = getList(listId) || getDefaultList();
    if (!activeList) {
      const newList = createList('Mes prières quotidiennes', true);
      saveState();
      view.activeListId = newList.id;
      openOrganizeModal(newList.id);
      return;
    }
    const items = getPrayerListItems(activeList.id);
    const ordered = orderedLists();
    const listsHtml = ordered.map((list, index) => `<li class="manage-item"><span class="drag-handle" aria-hidden="true">⋮⋮</span><span class="manage-title">${escapeHtml(list.title)}${list.isDefault ? ' <span class="tiny">(accueil)</span>' : ''}</span><span class="manage-actions"><button class="compact-icon" type="button" title="Monter" aria-label="Monter ${escapeHtml(list.title)}" data-action="move-list" data-direction="up" data-list-id="${escapeHtml(list.id)}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="compact-icon" type="button" title="Descendre" aria-label="Descendre ${escapeHtml(list.title)}" data-action="move-list" data-direction="down" data-list-id="${escapeHtml(list.id)}" ${index === ordered.length - 1 ? 'disabled' : ''}>↓</button><button class="compact-icon" type="button" title="Ouvrir" aria-label="Ouvrir ${escapeHtml(list.title)}" data-action="manage-select-list" data-list-id="${escapeHtml(list.id)}">${icon('chevronRight')}</button></span></li>`).join('');
    const prayersHtml = items.length ? items.map(({ prayer }) => `<li class="manage-item" draggable="true" data-prayer-id="${escapeHtml(prayer.id)}"><span class="drag-handle" aria-hidden="true">⋮⋮</span><span class="manage-title">${escapeHtml(prayer.title)}</span><span class="manage-actions"><button class="compact-icon" type="button" title="Monter" aria-label="Monter ${escapeHtml(prayer.title)}" data-action="move-prayer" data-direction="up" data-prayer-id="${escapeHtml(prayer.id)}" data-list-id="${escapeHtml(activeList.id)}">↑</button><button class="compact-icon" type="button" title="Descendre" aria-label="Descendre ${escapeHtml(prayer.title)}" data-action="move-prayer" data-direction="down" data-prayer-id="${escapeHtml(prayer.id)}" data-list-id="${escapeHtml(activeList.id)}">↓</button><button class="compact-icon" type="button" title="Retirer" aria-label="Retirer ${escapeHtml(prayer.title)}" data-action="remove-prayer" data-prayer-id="${escapeHtml(prayer.id)}" data-list-id="${escapeHtml(activeList.id)}">×</button></span></li>`).join('') : '<p class="subtle">Cette liste est vide.</p>';
    openModal('Organiser mes prières', `<section class="modal-section"><div class="form-row"><label for="list-title-input">Liste active</label><input id="list-title-input" type="text" value="${escapeHtml(activeList.title)}" maxlength="60"></div><div class="button-row"><button class="button small" type="button" data-action="save-list-title" data-list-id="${escapeHtml(activeList.id)}">Renommer</button><button class="button small" type="button" data-action="set-default-list" data-list-id="${escapeHtml(activeList.id)}" ${activeList.isDefault ? 'disabled' : ''}>${activeList.isDefault ? 'Liste d’accueil' : 'Définir comme accueil'}</button><button class="button small danger" type="button" data-action="delete-list" data-list-id="${escapeHtml(activeList.id)}">Supprimer la liste</button></div></section><section class="modal-section"><h3>Prières dans « ${escapeHtml(activeList.title)} »</h3><p class="tiny">Glissez une ligne pour changer l’ordre, ou utilisez les flèches.</p><ul class="manage-list" id="manage-prayer-list" data-list-id="${escapeHtml(activeList.id)}">${prayersHtml}</ul><div class="button-row"><button class="button primary" type="button" data-action="open-add-to-list" data-list-id="${escapeHtml(activeList.id)}">${icon('plus')} Ajouter une prière</button></div></section><section class="modal-section"><h3>Mes listes</h3><ul class="manage-list">${listsHtml}</ul><div class="button-row"><button class="button" type="button" data-action="open-create-list">Créer une liste</button></div></section>` , { onOpen: setupDragAndDrop });
  }

  function setupDragAndDrop(backdrop) {
    const container = $('#manage-prayer-list', backdrop);
    if (!container) return;
    let dragPrayerId = null;
    container.addEventListener('dragstart', event => {
      const row = event.target.closest('[data-prayer-id]');
      if (!row) return;
      dragPrayerId = row.dataset.prayerId;
      row.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    container.addEventListener('dragend', event => event.target.closest('[data-prayer-id]')?.classList.remove('dragging'));
    container.addEventListener('dragover', event => event.preventDefault());
    container.addEventListener('drop', event => {
      event.preventDefault();
      const target = event.target.closest('[data-prayer-id]');
      if (!target || !dragPrayerId || target.dataset.prayerId === dragPrayerId) return;
      const listId = container.dataset.listId;
      const current = getListItems(listId);
      const from = current.findIndex(item => item.prayerId === dragPrayerId);
      const to = current.findIndex(item => item.prayerId === target.dataset.prayerId);
      if (from < 0 || to < 0) return;
      const [moved] = current.splice(from, 1);
      current.splice(to, 0, moved);
      current.forEach((item, index) => { item.position = index; });
      saveState();
      openOrganizeModal(listId);
      toast('Ordre mis à jour.');
    });
  }

  function openAddPrayerToListModal(listId, preselectedPrayerId = null) {
    const list = getList(listId);
    if (!list) return;
    const checkboxes = corpus.prayers.map(prayer => {
      const checked = state.listItems.some(item => item.listId === list.id && item.prayerId === prayer.id) || prayer.id === preselectedPrayerId;
      return `<label class="check-row"><input type="checkbox" name="add-prayer" value="${escapeHtml(prayer.id)}" ${checked ? 'checked' : ''}><span>${escapeHtml(prayer.title)}</span></label>`;
    }).join('');
    openModal(`Ajouter à « ${list.title} »`, `<form id="add-prayer-form" data-list-id="${escapeHtml(list.id)}"><p class="subtle">Cochez les prières à afficher dans cette liste. Une même prière peut aussi figurer dans vos autres listes.</p><div class="check-grid">${checkboxes}</div><div class="button-row" style="margin-top:16px"><button class="button primary" type="submit">Enregistrer</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`);
  }

  function openAddPrayerToMultipleListsModal(prayerId) {
    const prayer = getPrayer(prayerId);
    if (!prayer) return;
    if (!state.lists.length) { openOrganizeModal(); return; }
    const checkboxes = orderedLists().map(list => {
      const checked = state.listItems.some(item => item.listId === list.id && item.prayerId === prayer.id);
      return `<label class="check-row"><input type="checkbox" name="prayer-list" value="${escapeHtml(list.id)}" ${checked ? 'checked' : ''}><span>${escapeHtml(list.title)}</span></label>`;
    }).join('');
    openModal('Ajouter à une liste', `<form id="multi-list-form" data-prayer-id="${escapeHtml(prayer.id)}"><p class="subtle">Choisissez les listes dans lesquelles « ${escapeHtml(prayer.title)} » doit apparaître.</p><div class="check-grid">${checkboxes}</div><div class="button-row" style="margin-top:16px"><button class="button primary" type="submit">Enregistrer</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`);
  }

  function openCreateListModal() {
    openModal('Créer une liste', `<form id="create-list-form"><div class="form-row"><label for="new-list-title">Nom de la liste</label><input id="new-list-title" type="text" maxlength="60" placeholder="Ex. Matin" required></div><div class="button-row"><button class="button primary" type="submit">Créer</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`);
  }

  function openSettingsModal() {
    openModal('Réglages', `<section class="modal-section"><div class="setting-row"><div><strong>Thème</strong><div class="tiny">Lumineux, sombre ou selon l’appareil.</div></div><select id="setting-theme" aria-label="Thème"><option value="system" ${state.settings.theme === 'system' ? 'selected' : ''}>Système</option><option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>Clair</option><option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>Sombre</option></select></div><div class="setting-row"><div><strong>Taille du texte</strong><div class="tiny">Appliquée à la lecture des prières.</div></div><select id="setting-font-scale" aria-label="Taille du texte"><option value="0.9" ${state.settings.fontScale === .9 ? 'selected' : ''}>Petite</option><option value="1" ${state.settings.fontScale === 1 ? 'selected' : ''}>Normale</option><option value="1.15" ${state.settings.fontScale === 1.15 ? 'selected' : ''}>Grande</option><option value="1.3" ${state.settings.fontScale === 1.3 ? 'selected' : ''}>Très grande</option></select></div><div class="setting-row"><div><strong>Interligne</strong></div><select id="setting-line-height" aria-label="Interligne"><option value="1.55" ${state.settings.lineHeight === 1.55 ? 'selected' : ''}>Compact</option><option value="1.72" ${state.settings.lineHeight === 1.72 ? 'selected' : ''}>Confortable</option><option value="1.9" ${state.settings.lineHeight === 1.9 ? 'selected' : ''}>Très aéré</option></select></div><div class="setting-row"><div><strong>Garder l’écran actif</strong><div class="tiny">Pendant la lecture d’une prière, lorsque l’appareil le permet.</div></div><input id="setting-wake-lock" type="checkbox" ${state.settings.keepScreenAwake ? 'checked' : ''} aria-label="Garder l’écran actif"></div></section><section class="modal-section"><h3>Mise à jour</h3><p class="tiny">Version installée : v${APP_RELEASE_VERSION} · Corpus ${escapeHtml(corpus.corpusVersion)}</p><div data-update-panel>${renderUpdatePanel()}</div><p class="tiny">La vérification nécessite Internet. Une mise à jour n’est jamais installée automatiquement pendant votre lecture.</p></section><section class="modal-section"><h3>Sauvegarde</h3><p class="subtle">Vos listes et réglages restent sur cet appareil. Sauvegardez-les avant de changer de téléphone ou d’iPad.</p><div class="button-row"><button class="button" type="button" data-action="export-state">Sauvegarder ma configuration</button><button class="button" type="button" data-action="import-state">Restaurer une configuration</button><button class="button" type="button" data-action="restore-last-backup">Restaurer la dernière sauvegarde automatique</button><input id="import-state-file" type="file" accept="application/json" hidden></div></section><section class="modal-section"><h3>Prototype</h3><p class="tiny">Application v${APP_RELEASE_VERSION} · Corpus ${escapeHtml(corpus.corpusVersion)}<br>${escapeHtml(corpus.status)}</p><div class="button-row"><button class="button danger" type="button" data-action="reset-local-data">Réinitialiser mes données locales</button></div></section>`);
  }

  function navigateToReader(prayerId, contextListId = null, origin = view.page) {
    const prayer = getPrayer(prayerId);
    if (!prayer) return;
    view = { ...view, page: 'reader', activeListMenu: false, reader: { prayerId, contextListId, origin, catalogQuery: view.catalogQuery, catalogCategory: view.catalogCategory } };
    render();
    requestAnimationFrame(() => {
      const savedPosition = state.lastRead[prayerId];
      if (Number.isFinite(savedPosition) && savedPosition > 0) window.scrollTo(0, savedPosition);
      else window.scrollTo(0, 0);
    });
    holdWakeLock();
  }

  function readerBack() {
    const reader = view.reader;
    releaseWakeLock();
    if (reader?.origin === 'catalog') {
      view = { ...view, page: 'catalog', reader: null };
    } else {
      view = { ...view, page: 'mine', reader: null, activeListId: reader?.contextListId || view.activeListId };
    }
    render();
  }

  async function holdWakeLock() {
    if (!state.settings.keepScreenAwake || !('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { /* Permission/device limitation; silently fall back. */ }
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

  function movePrayer(prayerId, listId, direction) {
    const items = getListItems(listId);
    const index = items.findIndex(item => item.prayerId === prayerId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return;
    [items[index].position, items[targetIndex].position] = [items[targetIndex].position, items[index].position];
    const list = getList(listId); if (list) list.updatedAt = new Date().toISOString();
    saveState();
    openOrganizeModal(listId);
  }

  function moveList(listId, direction) {
    const lists = orderedLists();
    const index = lists.findIndex(list => list.id === listId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= lists.length) return;
    [lists[index].position, lists[targetIndex].position] = [lists[targetIndex].position, lists[index].position];
    const timestamp = new Date().toISOString();
    lists[index].updatedAt = timestamp;
    lists[targetIndex].updatedAt = timestamp;
    saveState();
    openOrganizeModal(listId);
  }

  function exportState() {
    const payload = { exportedAt: new Date().toISOString(), appVersion: APP_VERSION, corpusVersion: corpus.corpusVersion, state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mes-prieres-configuration-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast('Sauvegarde téléchargée.');
  }

  async function importState(file) {
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const incoming = raw.state || raw;
      validateImportedState(incoming);
      const confirmReplace = window.confirm('Remplacer entièrement vos listes et réglages actuels ? Une sauvegarde automatique de la configuration actuelle sera créée avant le remplacement.');
      if (!confirmReplace) return;
      await saveAutomaticBackup('before-import');
      state = sanitizeState({ ...incoming, onboardingComplete: true });
      saveState();
      closeModal();
      view = { page: 'mine', activeListId: getDefaultList()?.id, activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null };
      render();
      toast('Configuration restaurée. La configuration précédente peut être restaurée depuis Réglages.');
    } catch (error) { toast(`Import impossible : ${error.message}`); }
  }

  async function restoreAutomaticBackup() {
    try {
      const backup = await loadAutomaticBackup();
      if (!backup) throw new Error('Aucune sauvegarde automatique valide n’est disponible.');
      if (!window.confirm(`Restaurer la sauvegarde automatique du ${new Date(backup.savedAt).toLocaleString('fr-FR')} ?`)) return;
      state = sanitizeState({ ...backup.state, onboardingComplete: true });
      saveState();
      closeModal();
      view = { page: 'mine', activeListId: getDefaultList()?.id, activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null };
      render();
      toast('Sauvegarde automatique restaurée.');
    } catch (error) { toast(`Restauration impossible : ${error.message}`); }
  }

  async function resetLocalData() {
    if (!window.confirm('Réinitialiser toutes vos listes et vos réglages sur cet appareil ? Cette action ne peut pas être annulée.')) return;
    // Drain prior asynchronous writes first, otherwise an older state could reappear after deletion.
    await persistenceQueue.catch(() => undefined);
    removeLocalValue(STORAGE_KEY);
    removeLocalValue(BACKUP_STORAGE_KEY);
    try {
      await Promise.all([clearStateFromDatabase(DB_KEY), clearStateFromDatabase(DB_BACKUP_KEY)]);
    } catch (error) {
      console.warn('Effacement IndexedDB impossible.', error);
      toast('Les données locales du navigateur ont été effacées ; IndexedDB n’a pas pu être confirmé.');
    }
    state = createInitialState();
    await saveState();
    closeModal();
    view = { page: 'mine', activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null };
    render();
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      serviceWorkerRegistration = registration;
      registration.addEventListener?.('updatefound', () => observeServiceWorkerUpdate(registration));
      observeServiceWorkerUpdate(registration);
      if (!navigator.serviceWorker.__mesPrieresControllerListener) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloadAfterServiceWorkerUpdate) {
            reloadAfterServiceWorkerUpdate = false;
            window.location.reload();
          }
        });
        navigator.serviceWorker.__mesPrieresControllerListener = true;
      }
      return registration;
    } catch (error) {
      console.warn('Service worker non enregistré', error);
      return null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && view.page === 'reader') holdWakeLock();
    else releaseWakeLock();
  });
  window.addEventListener('beforeunload', () => releaseWakeLock());
  let saveReadingPositionTimer = null;
  window.addEventListener('scroll', () => {
    if (view.page !== 'reader' || !view.reader?.prayerId) return;
    state.lastRead[view.reader.prayerId] = window.scrollY;
    window.clearTimeout(saveReadingPositionTimer);
    saveReadingPositionTimer = window.setTimeout(saveState, 400);
  }, { passive: true });

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'close-modal') return closeModal();
    if (action === 'onboard-choose') return beginOnboarding('choose');
    if (action === 'onboard-suggested') return beginOnboarding('suggested');
    if (action === 'onboard-empty') return beginOnboarding('empty');
    if (action === 'go-mine') { releaseWakeLock(); view = { ...view, page: 'mine', activeListMenu: false, reader: null }; return render(); }
    if (action === 'go-catalog') { releaseWakeLock(); view = { ...view, page: 'catalog', activeListMenu: false, reader: null }; return render(); }
    if (action === 'toggle-list-menu') { view.activeListMenu = !view.activeListMenu; return render(); }
    if (action === 'select-list') { view.activeListId = target.dataset.listId; view.activeListMenu = false; view.page = 'mine'; return render(); }
    if (action === 'open-prayer') return navigateToReader(target.dataset.prayerId, target.dataset.contextListId || null, view.page);
    if (action === 'reader-back') return readerBack();
    if (action === 'open-adjacent' && target.dataset.prayerId) return navigateToReader(target.dataset.prayerId, view.reader?.contextListId, 'mine');
    if (action === 'organize-list') return openOrganizeModal();
    if (action === 'open-settings') return openSettingsModal();
    if (action === 'check-for-updates') return checkForUpdates({ userInitiated: true });
    if (action === 'install-update') return installAvailableUpdate();
    if (action === 'open-help') return openHelp();
    if (action === 'help-back') return helpBack();
    if (action === 'set-category') { view.catalogCategory = target.dataset.category; return render(); }
    if (action === 'clear-catalog') { view.catalogQuery = ''; view.catalogCategory = 'Toutes'; return render(); }
    if (action === 'open-add-to-list') return openAddPrayerToListModal(target.dataset.listId);
    if (action === 'add-prayer-to-lists') return openAddPrayerToMultipleListsModal(target.dataset.prayerId);
    if (action === 'move-prayer') return movePrayer(target.dataset.prayerId, target.dataset.listId, target.dataset.direction);
    if (action === 'move-list') return moveList(target.dataset.listId, target.dataset.direction);
    if (action === 'remove-prayer') { removePrayerFromList(target.dataset.prayerId, target.dataset.listId); saveState(); return openOrganizeModal(target.dataset.listId); }
    if (action === 'manage-select-list') { closeModal(); view.activeListId = target.dataset.listId; return openOrganizeModal(target.dataset.listId); }
    if (action === 'open-create-list') return openCreateListModal();
    if (action === 'save-list-title') {
      const title = $('#list-title-input')?.value.trim();
      if (!title) { toast('Donnez un nom à la liste.'); return; }
      const list = getList(target.dataset.listId); if (list) { list.title = title; saveState(); openOrganizeModal(list.id); }
      return;
    }
    if (action === 'set-default-list') { setDefaultList(target.dataset.listId); saveState(); openOrganizeModal(target.dataset.listId); return; }
    if (action === 'delete-list') {
      const list = getList(target.dataset.listId);
      if (!list || !window.confirm(`Supprimer la liste « ${list.title} » ? Les prières resteront dans le Répertoire et dans vos autres listes.`)) return;
      if (deleteList(list.id)) { saveState(); closeModal(); view.activeListId = getDefaultList()?.id; render(); toast('Liste supprimée.'); }
      return;
    }
    if (action === 'export-state') return exportState();
    if (action === 'import-state') return $('#import-state-file')?.click();
    if (action === 'restore-last-backup') return restoreAutomaticBackup();
    if (action === 'reset-local-data') return resetLocalData();
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'catalog-search') {
      view.catalogQuery = event.target.value;
      const position = event.target.selectionStart;
      render();
      requestAnimationFrame(() => { const search = $('#catalog-search'); search?.focus(); search?.setSelectionRange(position, position); });
    }
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'setting-theme') { state.settings.theme = event.target.value; saveState(); render(); return openSettingsModal(); }
    if (event.target.id === 'setting-font-scale') { state.settings.fontScale = Number(event.target.value); saveState(); render(); return openSettingsModal(); }
    if (event.target.id === 'setting-line-height') { state.settings.lineHeight = Number(event.target.value); saveState(); render(); return openSettingsModal(); }
    if (event.target.id === 'setting-wake-lock') { state.settings.keepScreenAwake = event.target.checked; saveState(); if (event.target.checked && view.page === 'reader') holdWakeLock(); else if (!event.target.checked) releaseWakeLock(); return; }
    if (event.target.id === 'import-state-file') { importState(event.target.files?.[0]); return; }
  });

  document.addEventListener('submit', event => {
    if (event.target.id === 'initial-list-form') {
      event.preventDefault();
      const title = $('#initial-list-title', event.target)?.value.trim();
      const selected = $$('input[name="initial-prayer"]:checked', event.target).map(input => input.value);
      const list = createList(title || 'Mes prières quotidiennes', true);
      selected.forEach(id => addPrayerToList(id, list.id));
      state.onboardingComplete = true;
      saveState();
      closeModal();
      view = { page: 'mine', activeListId: list.id, activeListMenu: false, catalogQuery: '', catalogCategory: 'Toutes', reader: null };
      render();
      return;
    }
    if (event.target.id === 'add-prayer-form') {
      event.preventDefault();
      const listId = event.target.dataset.listId;
      const checked = new Set($$('input[name="add-prayer"]:checked', event.target).map(input => input.value));
      corpus.prayers.forEach(prayer => {
        const exists = state.listItems.some(item => item.listId === listId && item.prayerId === prayer.id);
        if (checked.has(prayer.id) && !exists) addPrayerToList(prayer.id, listId);
        if (!checked.has(prayer.id) && exists) removePrayerFromList(prayer.id, listId);
      });
      saveState(); closeModal(); view.activeListId = listId; render(); toast('Liste mise à jour.'); return;
    }
    if (event.target.id === 'multi-list-form') {
      event.preventDefault();
      const prayerId = event.target.dataset.prayerId;
      const selected = new Set($$('input[name="prayer-list"]:checked', event.target).map(input => input.value));
      orderedLists().forEach(list => {
        const exists = state.listItems.some(item => item.listId === list.id && item.prayerId === prayerId);
        if (selected.has(list.id) && !exists) addPrayerToList(prayerId, list.id);
        if (!selected.has(list.id) && exists) removePrayerFromList(prayerId, list.id);
      });
      saveState(); closeModal(); render(); toast('Listes mises à jour.'); return;
    }
    if (event.target.id === 'create-list-form') {
      event.preventDefault();
      const title = $('#new-list-title', event.target)?.value.trim();
      if (!title) return;
      const list = createList(title, state.lists.length === 0);
      saveState(); closeModal(); view.activeListId = list.id; openOrganizeModal(list.id); return;
    }
  });

  function icon(name) {
    const icons = {
      help: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M9.6 9a2.5 2.5 0 1 1 4.5 1.5c-.9 1.1-2.1 1.4-2.1 3"></path><path d="M12 17h.01"></path></svg>',
      settings: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2 2-.06-.06A1.7 1.7 0 0 0 15.86 18a1.7 1.7 0 0 0-1.36 1.64V20h-3v-.36A1.7 1.7 0 0 0 10.14 18a1.7 1.7 0 0 0-1.88.34l-.06.06-2-2 .06-.06A1.7 1.7 0 0 0 6 15.86a1.7 1.7 0 0 0-1.64-1.36H4v-3h.36A1.7 1.7 0 0 0 6 10.14a1.7 1.7 0 0 0-.34-1.88L5.6 8.2l2-2 .06.06A1.7 1.7 0 0 0 9.54 6 1.7 1.7 0 0 0 10.9 4.36V4h3v.36A1.7 1.7 0 0 0 15.26 6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2 2-.06.06A1.7 1.7 0 0 0 18.8 9.54 1.7 1.7 0 0 0 20.44 10.9H21v3h-.36A1.7 1.7 0 0 0 19.4 15Z"></path></svg>',
      book: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5.5c3.2-1 6.3-.5 8 1.4 1.7-1.9 4.8-2.4 8-1.4v13c-3.2-1-6.3-.5-8 1.4-1.7-1.9-4.8-2.4-8-1.4v-13Z"></path><path d="M12 6.9v13"></path></svg>',
      search: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.5"></circle><path d="m16 16 4 4"></path></svg>',
      chevronRight: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg>',
      chevronLeft: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"></path></svg>',
      chevronDown: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"></path></svg>',
      close: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg>',
      plus: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>'
    };
    return icons[name] || '';
  }

  init();
})();
