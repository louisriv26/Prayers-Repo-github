#!/usr/bin/env python3
"""Generate or verify the browser help bundle from its canonical JSON source."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data' / 'help.json'
OUTPUT = ROOT / 'data' / 'help.js'


def expected_output() -> str:
    data = json.loads(SOURCE.read_text(encoding='utf-8'))
    return 'window.APP_HELP = ' + json.dumps(data, ensure_ascii=False, indent=2) + ';\n'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Fail rather than write when data/help.js is stale.')
    args = parser.parse_args()
    expected = expected_output()
    current = OUTPUT.read_text(encoding='utf-8') if OUTPUT.exists() else ''
    if args.check:
        if current != expected:
            print('HELP_BUNDLE: FAIL — data/help.js is stale; run python3 tools/generate_help_js.py')
            return 1
        print('HELP_BUNDLE: PASS')
        return 0
    OUTPUT.write_text(expected, encoding='utf-8')
    print(f'Generated {OUTPUT.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
