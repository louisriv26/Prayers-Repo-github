#!/usr/bin/env python3
"""Generate or verify the browser-ready corpus from its canonical JSON source."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data' / 'prayers.json'
OUTPUT = ROOT / 'data' / 'prayers.js'


def expected_output() -> str:
    corpus = json.loads(SOURCE.read_text(encoding='utf-8'))
    return (
        '/* Generated from prayers.json. Do not hand-edit; update prayers.json and regenerate. */\n'
        + 'window.PRAYER_CORPUS = '
        + json.dumps(corpus, ensure_ascii=False, indent=2)
        + ';\n'
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Fail rather than write when data/prayers.js is stale.')
    args = parser.parse_args()
    expected = expected_output()
    current = OUTPUT.read_text(encoding='utf-8') if OUTPUT.exists() else ''
    if args.check:
        if current != expected:
            print('CORPUS_BUNDLE: FAIL — data/prayers.js is stale; run python3 tools/generate_corpus_js.py')
            return 1
        print('CORPUS_BUNDLE: PASS')
        return 0
    OUTPUT.write_text(expected, encoding='utf-8')
    print(f'Generated {OUTPUT.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
