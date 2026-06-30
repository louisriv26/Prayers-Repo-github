"""Browser-DOM test harness. It does not start a server or register a service worker.

The managed Chromium in this environment blocks navigation to every URL. The harness
therefore embeds the packaged HTML/CSS/JS in a browser document and validates interactive
application behavior, local-storage persistence semantics, import backup/restore,
keyboard-modal containment and responsive rendering. Actual service-worker installation
offline navigation remain explicit real-device/permitted-browser gates.
"""

import json
import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / 'app.js').read_text(encoding='utf-8')
STYLES = (ROOT / 'styles.css').read_text(encoding='utf-8')
CORPUS = json.loads((ROOT / 'data/prayers.json').read_text(encoding='utf-8'))
HELP = json.loads((ROOT / 'data/help.json').read_text(encoding='utf-8'))
RELEASE = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))


def html_document(storage_seed: dict | None = None) -> str:
    seed = json.dumps(storage_seed or {}, ensure_ascii=False).replace('</', '<\\/')
    corpus = json.dumps(CORPUS, ensure_ascii=False).replace('</', '<\\/')
    help_content = json.dumps(HELP, ensure_ascii=False).replace('</', '<\\/')
    release = json.dumps(RELEASE, ensure_ascii=False).replace('</', '<\\/')
    app = APP_JS.replace('</script', '<\\/script')
    styles = STYLES.replace('</style', '<\\/style')
    return f'''<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mes prières test</title><style>{styles}</style></head>
<body>
  <a class="skip-link" href="#app-main">Aller au contenu principal</a>
  <div id="app" class="app-shell"><div class="boot-screen">Chargement</div></div>
  <script>
    (() => {{
      const store = new Map(Object.entries({seed}));
      const storage = {{
        getItem: key => store.has(key) ? store.get(key) : null,
        setItem: (key, value) => {{ store.set(String(key), String(value)); }},
        removeItem: key => {{ store.delete(String(key)); }},
        clear: () => store.clear()
      }};
      Object.defineProperty(window, 'localStorage', {{ value: storage, configurable: true }});
      try {{ delete window.indexedDB; }} catch (_) {{ Object.defineProperty(window, 'indexedDB', {{ value: undefined, configurable: true }}); }}
      window.matchMedia = window.matchMedia || (() => ({{ matches: false, addEventListener() {{}}, removeEventListener() {{}} }}));
      window.confirm = () => true;
      window.__testStorageSnapshot = () => Object.fromEntries(store.entries());
      window.__testReleaseMetadata = {release};
      window.fetch = async input => {{
        if (String(input).includes('release.json')) {{
          return new Response(JSON.stringify(window.__testReleaseMetadata), {{ status: 200, headers: {{ 'Content-Type': 'application/json' }} }});
        }}
        throw new Error(`Unexpected test fetch: ${{String(input)}}`);
      }};
    }})();
  </script>
  <script>window.PRAYER_CORPUS = {corpus};</script>
  <script>window.APP_HELP = {help_content};</script>
  <script>{app}</script>
</body></html>'''


def write_import_fixture(path: Path) -> None:
    state = {
        'schemaVersion': 1,
        'onboardingComplete': True,
        'lists': [{'id': 'imported_list', 'title': 'Importée', 'position': 0, 'isDefault': True,
                   'createdAt': '2026-06-30T00:00:00.000Z', 'updatedAt': '2026-06-30T00:00:00.000Z'}],
        'listItems': [{'id': 'imported_item', 'listId': 'imported_list',
                       'prayerId': 'priere_abandon_charles_de_foucauld', 'position': 0}],
        'settings': {'theme': 'light', 'fontScale': 1.15, 'lineHeight': 1.72, 'keepScreenAwake': False},
        'lastRead': {},
        'createdAt': '2026-06-30T00:00:00.000Z',
        'updatedAt': '2026-06-30T00:00:00.000Z',
    }
    path.write_text(json.dumps({'state': state}, ensure_ascii=False), encoding='utf-8')


def chromium_executable(playwright_browser_type) -> str:
    configured = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH')
    if configured and Path(configured).is_file():
        return configured
    system_chromium = Path('/usr/bin/chromium')
    if system_chromium.is_file():
        return str(system_chromium)
    return playwright_browser_type.executable_path


def load_harness_page(context, storage_seed=None):
    page = context.new_page()
    page.set_default_timeout(10000)
    page.set_content(html_document(storage_seed), wait_until='load')
    if storage_seed:
        page.get_by_role('button', name='Mes prières quotidiennes', exact=True).wait_for()
    else:
        page.get_by_role('heading', name='Votre livre de prières personnel').wait_for()
    return page


with tempfile.TemporaryDirectory(prefix='mes-prieres-import-') as tmp_dir:
    fixture = Path(tmp_dir) / 'import.json'
    write_import_fixture(fixture)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=chromium_executable(p.chromium), args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        page = load_harness_page(context)

        print('step: onboarding help, contents and no global live region', flush=True)
        assert page.locator('#app').get_attribute('aria-live') is None
        page.get_by_role('button', name='Aide').click()
        page.get_by_role('heading', name='Aide').wait_for()
        assert page.locator('[data-help-page] .help-section').count() == len(HELP['sections'])
        assert page.locator('.help-toc a[href="#help-sauvegarde"]').count() == 1
        assert page.locator('.help-toc a[href="#help-mises-a-jour"]').count() == 1
        assert page.locator('#help-mises-a-jour').get_by_text('Vérifier les mises à jour').is_visible()
        assert page.get_by_text('Cette application ne synchronise pas automatiquement vos listes entre votre téléphone, votre iPad et vos autres appareils.').is_visible()
        assert page.get_by_text('Le comportement réel d’installation, du service worker et du rechargement hors ligne doit encore être vérifié sur iPhone, iPad et Android.').is_visible()
        assert page.locator('.help-page').bounding_box()['width'] <= 390
        page.locator('.help-toc a[href="#help-sauvegarde"]').click()
        page.locator('#help-sauvegarde').wait_for()
        page.get_by_role('button', name='Retour').click()
        page.get_by_role('heading', name='Votre livre de prières personnel').wait_for()

        print('step: onboarding, reader and help return context', flush=True)
        page.get_by_role('button', name='Commencer avec une sélection proposée').click()
        page.get_by_text('Ma prière du OUI pour aujourd’hui').wait_for()
        page.get_by_role('button', name='Prière à Saint Michel').click()
        page.get_by_role('heading', name='Prière à Saint Michel').wait_for()
        page.get_by_role('button', name='Ajouter à une liste').click()
        page.get_by_role('heading', name='Ajouter à une liste').wait_for()
        page.keyboard.press('Escape')
        page.get_by_role('button', name='Aide').click()
        page.get_by_role('heading', name='Aide').wait_for()
        page.get_by_role('button', name='Retour').click()
        page.get_by_role('heading', name='Prière à Saint Michel').wait_for()
        page.get_by_role('button', name='Retour').click()

        print('step: help return restores reader scroll position', flush=True)
        page.get_by_role('button', name='Prière d’infusion dans la Divine Volonté').click()
        page.get_by_role('heading', name='Prière d’infusion dans la Divine Volonté').wait_for()
        page.evaluate('window.scrollTo(0, 260)')
        prior_scroll = page.evaluate('window.scrollY')
        page.get_by_role('button', name='Aide').click()
        page.get_by_role('heading', name='Aide').wait_for()
        page.get_by_role('button', name='Retour').click()
        page.get_by_role('heading', name='Prière d’infusion dans la Divine Volonté').wait_for()
        page.wait_for_timeout(50)
        assert page.evaluate('window.scrollY') >= prior_scroll - 2
        page.get_by_role('button', name='Retour').click()

        print('step: catalogue search and reader back context', flush=True)
        page.get_by_role('button', name='Répertoire').click()
        search = page.get_by_role('searchbox', name='Rechercher une prière')
        search.fill('Zacharie')
        page.get_by_text('Cantique de Zacharie (Lc 1, 68-79)').wait_for()
        page.get_by_role('button', name='Cantique de Zacharie (Lc 1, 68-79)').click()
        page.get_by_role('heading', name='Cantique de Zacharie (Lc 1, 68-79)').wait_for()
        page.get_by_role('button', name='Retour').click()
        assert page.get_by_role('searchbox', name='Rechercher une prière').input_value() == 'Zacharie'
        search = page.get_by_role('searchbox', name='Rechercher une prière')
        search.fill('misericorde')
        page.get_by_text('Ma prière du OUI pour aujourd’hui').wait_for()

        print('step: create list, multi-list and item order', flush=True)
        page.get_by_role('button', name='Mes prières').click()
        page.get_by_role('button', name='Organiser').click()
        page.get_by_role('heading', name='Organiser mes prières').wait_for()
        page.get_by_role('button', name='Créer une liste').click()
        page.get_by_role('textbox', name='Nom de la liste').fill('Voyage')
        page.get_by_role('button', name='Créer').click()
        page.get_by_text('Prières dans « Voyage »').wait_for()
        page.get_by_role('button', name='Ajouter une prière').click()
        page.locator('input[name="add-prayer"][value="priere_saint_michel"]').check()
        page.get_by_role('button', name='Enregistrer').click()
        page.get_by_role('button', name='Organiser').click()
        page.get_by_role('button', name='Ajouter une prière').click()
        page.locator('input[name="add-prayer"][value="ame_du_christ"]').check()
        page.get_by_role('button', name='Enregistrer').click()
        page.get_by_role('button', name='Organiser').click()
        page.get_by_role('button', name='Monter Âme du Christ').click()
        ordered_titles = page.locator('#manage-prayer-list .manage-title').all_inner_texts()
        assert ordered_titles[:2] == ['Âme du Christ', 'Prière à Saint Michel']

        print('step: list order and keyboard modal focus trap', flush=True)
        page.get_by_role('button', name='Créer une liste').click()
        page.get_by_role('textbox', name='Nom de la liste').fill('Soir')
        page.get_by_role('button', name='Créer').click()
        page.get_by_role('heading', name='Organiser mes prières').wait_for()
        page.get_by_role('button', name='Monter Soir').click()
        list_titles = page.locator('.modal-section').filter(has_text='Mes listes').locator('.manage-title').all_inner_texts()
        assert list_titles[:3] == ['Mes prières quotidiennes (accueil)', 'Soir', 'Voyage']
        page.evaluate("""() => { const m=document.querySelector('.modal'); const nodes=[...m.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary:not([disabled])')].filter(e=>!e.hidden && e.getClientRects().length); nodes[nodes.length-1].focus(); }""")
        page.keyboard.press('Tab')
        assert page.evaluate("document.activeElement.getAttribute('aria-label')") == 'Fermer'

        print('step: local persistence reconstruction', flush=True)
        storage_snapshot = page.evaluate('window.__testStorageSnapshot()')
        page.close()
        page = load_harness_page(context, storage_snapshot)
        page.get_by_role('button', name='Mes prières quotidiennes', exact=True).click()
        menu_titles = page.locator('.menu button').all_inner_texts()
        assert [x.replace('✓', '').strip() for x in menu_titles[:3]] == ['Mes prières quotidiennes', 'Soir', 'Voyage']
        page.get_by_role('button', name='Voyage', exact=True).click()
        page.get_by_role('button', name='Âme du Christ', exact=True).wait_for()
        page.get_by_role('button', name='Âme du Christ', exact=True).click()
        page.get_by_role('heading', name='Âme du Christ').wait_for()
        page.get_by_role('button', name='Prière à Saint Michel').click()
        page.get_by_role('heading', name='Prière à Saint Michel').wait_for()

        print('step: guarded import and automatic restore', flush=True)
        page.get_by_role('button', name='Réglages').click()
        page.get_by_role('button', name='Restaurer une configuration').click()
        page.locator('#import-state-file').set_input_files(str(fixture))
        page.get_by_role('button', name='Importée', exact=True).wait_for()
        page.get_by_role('button', name='Réglages').click()
        page.get_by_role('button', name='Restaurer la dernière sauvegarde automatique').click()
        page.get_by_role('button', name='Mes prières quotidiennes', exact=True).wait_for()
        page.get_by_role('button', name='Mes prières quotidiennes', exact=True).click()
        page.get_by_role('button', name='Voyage', exact=True).wait_for()
        page.get_by_role('button', name='Mes prières quotidiennes', exact=True).click()

        print('step: installed version and manual update check', flush=True)
        page.get_by_role('button', name='Réglages').click()
        page.get_by_text('Version installée : v0.1.6').wait_for()
        page.get_by_role('button', name='Vérifier les mises à jour').click()
        page.get_by_text('À jour : v0.1.6 correspond à la version actuellement accessible', exact=False).wait_for()
        page.evaluate("() => { window.__testReleaseMetadata = { schemaVersion: 1, version: '0.1.7', appVersion: '0.1.7-help-audited-prototype', publishedAt: '2026-07-01', releaseNotes: 'Mise à jour de test.' }; }")
        page.get_by_role('button', name='Vérifier les mises à jour').click()
        page.get_by_role('button', name='Installer la mise à jour v0.1.7').wait_for()
        page.evaluate("() => { window.__testReleaseMetadata = { schemaVersion: 1, version: 'invalide', appVersion: 'invalide', publishedAt: '2026-07-01', releaseNotes: '' }; }")
        page.get_by_role('button', name='Vérifier les mises à jour').click()
        page.get_by_text('Impossible de vérifier une nouvelle version', exact=False).wait_for()
        page.get_by_role('button', name='Fermer').click()

        print('step: responsive reader layout', flush=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        page.get_by_role('button', name='Prière à Saint Michel').click()
        page.get_by_role('heading', name='Prière à Saint Michel').wait_for()
        assert page.locator('.reader-content').bounding_box()['width'] <= 390
        page.set_viewport_size({'width': 1024, 'height': 768})
        assert page.locator('.reader-content').bounding_box()['width'] <= 740.5

        print('step: reset returns to clean onboarding state', flush=True)
        page.get_by_role('button', name='Réglages').click()
        page.get_by_role('button', name='Réinitialiser mes données locales').click()
        page.get_by_role('heading', name='Votre livre de prières personnel').wait_for()

        browser.close()
print('DOM_E2E: PASS')
