#!/usr/bin/env python3
"""Validate that the generated GitHub Pages artifact is minimal and project-path safe."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    Path('index.html'), Path('styles.css'), Path('app.js'), Path('manifest.webmanifest'), Path('sw.js'),
    Path('data/prayers.json'), Path('data/prayers.js'), Path('data/help.json'), Path('data/help.js'), Path('release.json'),
    Path('icons/icon.svg'), Path('icons/icon-192.png'), Path('icons/icon-512.png'),
)
EXPECTED_SITE_FILES = set(RUNTIME_FILES) | {Path('.nojekyll')}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def site_files(site: Path) -> set[Path]:
    return {path.relative_to(site) for path in site.rglob('*') if path.is_file()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', required=True, help='Generated Pages directory.')
    args = parser.parse_args()
    site = Path(args.site).resolve()
    failures: list[str] = []
    if not site.is_dir():
        failures.append('Le dossier site est absent.')
    else:
        actual = site_files(site)
        if actual != EXPECTED_SITE_FILES:
            missing = sorted(str(item) for item in EXPECTED_SITE_FILES - actual)
            extra = sorted(str(item) for item in actual - EXPECTED_SITE_FILES)
            if missing:
                failures.append(f'Fichiers runtime absents : {", ".join(missing)}')
            if extra:
                failures.append(f'Fichiers non publiables présents : {", ".join(extra)}')
        for relative in RUNTIME_FILES:
            source, target = ROOT / relative, site / relative
            if not target.is_file() or sha256(source) != sha256(target):
                failures.append(f'Le fichier déployé diffère du runtime source : {relative}')

        if (site / 'index.html').is_file():
            index = (site / 'index.html').read_text(encoding='utf-8')
            for expected in ['href="manifest.webmanifest"', 'href="styles.css"', 'src="data/prayers.js"', 'src="data/help.js"', 'src="app.js"']:
                if expected not in index:
                    failures.append(f'index.html ne contient pas la référence relative attendue : {expected}')
            if re.search(r'(?:href|src)="/(?!/)', index):
                failures.append('index.html contient une URL absolue incompatible avec un site Pages de projet.')

        if (site / 'manifest.webmanifest').is_file():
            manifest = json.loads((site / 'manifest.webmanifest').read_text(encoding='utf-8'))
            for key in ['start_url', 'scope', 'id']:
                if manifest.get(key) != './':
                    failures.append(f'manifest.webmanifest {key} doit être "./" pour le sous-chemin GitHub Pages.')

        if (site / 'release.json').is_file():
            release = json.loads((site / 'release.json').read_text(encoding='utf-8'))
            package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
            if release.get('version') != package.get('version') or release.get('appVersion') != f"{package.get('version')}-help-audited-prototype":
                failures.append('release.json déployé ne correspond pas à l’identité applicative.')

        if (site / 'app.js').is_file():
            app = (site / 'app.js').read_text(encoding='utf-8')
            if "navigator.serviceWorker.register('./sw.js')" not in app:
                failures.append('app.js n’enregistre pas le service worker avec un chemin relatif de projet.')

        if (site / 'sw.js').is_file():
            sw = (site / 'sw.js').read_text(encoding='utf-8')
            for asset in ['./', './index.html', './data/help.js', './icons/icon-512.png']:
                if f"'{asset}'" not in sw:
                    failures.append(f'sw.js ne met pas en cache l’asset relatif requis : {asset}')
            if "'/index.html'" in sw or '"/index.html"' in sw:
                failures.append('sw.js contient une racine absolue incompatible avec un site Pages de projet.')
            if "requestUrl.pathname.endsWith('/release.json')" not in sw or 'event.respondWith(fetch(event.request)); return;' not in sw:
                failures.append('sw.js doit laisser release.json sur le réseau pour la vérification des mises à jour.')
            if "'./release.json'" in sw:
                failures.append('sw.js ne doit pas précacher release.json.')

    if failures:
        print('PAGES_SITE_VALIDATE: FAIL')
        for failure in failures:
            print(f'- {failure}')
        return 1
    print('PAGES_SITE_VALIDATE: PASS')
    print(f'Files: {len(EXPECTED_SITE_FILES)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
