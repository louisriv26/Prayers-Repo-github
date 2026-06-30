#!/usr/bin/env python3
"""Negative tests proving raw release audits reject stale generated artifacts without repairing them."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], cwd: Path, expect: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if result.returncode != expect:
        raise AssertionError(
            f"Unexpected exit {result.returncode} for {' '.join(command)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def main() -> int:
    with tempfile.TemporaryDirectory(prefix='mes-prieres-integrity-') as temp:
        copied_root = Path(temp) / ROOT.name
        shutil.copytree(ROOT, copied_root, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        corpus_bundle = copied_root / 'data/prayers.js'
        help_bundle = copied_root / 'data/help.js'
        service_worker = copied_root / 'sw.js'
        corpus_bundle.write_text(corpus_bundle.read_text(encoding='utf-8') + '\n/* stale corpus guard */\n', encoding='utf-8')
        help_bundle.write_text(help_bundle.read_text(encoding='utf-8') + '\n/* stale help guard */\n', encoding='utf-8')
        service_worker.write_text(service_worker.read_text(encoding='utf-8') + '\n/* stale service-worker guard */\n', encoding='utf-8')
        stale_corpus_hash = sha256(corpus_bundle)
        stale_help_hash = sha256(help_bundle)
        stale_sw_hash = sha256(service_worker)

        # The audit must report stale bundles without repairing any copied file.
        result = run([sys.executable, 'tools/release_audit.py', '--prepackage'], copied_root, expect=1)
        evidence = result.stdout + result.stderr
        for expected_error in [
            'data/prayers.js n’est pas le résultat actuel',
            'data/help.js n’est pas le résultat actuel',
            'sw.js n’est pas le résultat actuel',
        ]:
            if expected_error not in evidence:
                raise AssertionError(f'Expected stale-artifact failure not found: {expected_error}')
        if (
            sha256(corpus_bundle) != stale_corpus_hash
            or sha256(help_bundle) != stale_help_hash
            or sha256(service_worker) != stale_sw_hash
        ):
            raise AssertionError('Release audit unexpectedly modified a stale generated bundle.')

        # Explicit generators repair the copies; the raw release audit then passes.
        run([sys.executable, 'tools/generate_corpus_js.py'], copied_root)
        run([sys.executable, 'tools/generate_help_js.py'], copied_root)
        run([sys.executable, 'tools/generate_sw.py'], copied_root)
        run([sys.executable, 'tools/release_audit.py', '--prepackage'], copied_root)

    print('INTEGRITY_GUARDS: PASS')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
