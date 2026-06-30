#!/usr/bin/env python3
"""Create the minimal static artifact that GitHub Pages is allowed to publish."""
from __future__ import annotations

import argparse
import hashlib
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    Path('index.html'),
    Path('styles.css'),
    Path('app.js'),
    Path('manifest.webmanifest'),
    Path('sw.js'),
    Path('data/prayers.json'),
    Path('data/prayers.js'),
    Path('data/help.json'),
    Path('release.json'),
    Path('data/help.js'),
    Path('icons/icon.svg'),
    Path('icons/icon-192.png'),
    Path('icons/icon-512.png'),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='site', help='Deployment directory, relative to the repository root unless absolute.')
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute():
        output = (ROOT / output).resolve()
    if output == ROOT or ROOT not in output.parents:
        raise SystemExit('Refus : le dossier de publication doit être un sous-dossier du dépôt, distinct de sa racine.')

    for relative in RUNTIME_FILES:
        if not (ROOT / relative).is_file():
            raise SystemExit(f'Runtime source missing: {relative}')

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    for relative in RUNTIME_FILES:
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    (output / '.nojekyll').write_text('', encoding='utf-8')

    print('PAGES_SITE_PREPARE: PASS')
    print(f'Output: {output}')
    for relative in RUNTIME_FILES:
        print(f'{sha256(ROOT / relative)}  {relative.as_posix()}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
