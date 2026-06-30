#!/usr/bin/env python3
"""Generate the active service worker with a cache key bound to runtime assets."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'sw.template.js'
OUTPUT = ROOT / 'sw.js'
CORE_INPUTS = [
    'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
    'data/prayers.json', 'data/prayers.js', 'data/help.json', 'data/help.js', 'release.json', 'icons/icon.svg',
    'icons/icon-192.png', 'icons/icon-512.png', 'sw.template.js',
]


def cache_version() -> str:
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    digest = hashlib.sha256()
    for relative in CORE_INPUTS:
        path = ROOT / relative
        digest.update(relative.encode('utf-8'))
        digest.update(b'\0')
        digest.update(path.read_bytes())
        digest.update(b'\0')
    return f"mes-prieres-pwa-prototype-v{package['version']}-audited-{digest.hexdigest()[:12]}"


def expected_output() -> str:
    template = TEMPLATE.read_text(encoding='utf-8')
    if template.count('__CACHE_VERSION__') != 1:
        raise ValueError('Le modèle du service worker doit contenir exactement un token __CACHE_VERSION__.')
    return template.replace('__CACHE_VERSION__', cache_version())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Fail rather than write when sw.js is stale.')
    args = parser.parse_args()
    expected = expected_output()
    current = OUTPUT.read_text(encoding='utf-8') if OUTPUT.exists() else ''
    if args.check:
        if current != expected:
            print('SERVICE_WORKER: FAIL — sw.js is stale; run python3 tools/generate_sw.py')
            return 1
        print(f'SERVICE_WORKER: PASS\nCache: {cache_version()}')
        return 0
    OUTPUT.write_text(expected, encoding='utf-8')
    print(f'Generated sw.js\nCache: {cache_version()}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
