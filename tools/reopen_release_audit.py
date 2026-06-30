#!/usr/bin/env python3
"""Reopen an immutable release ZIP in a fresh directory and audit only that copy."""
from __future__ import annotations

import argparse
import hashlib
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
MAX_MEMBER_BYTES = 5 * 1024 * 1024
COMMAND_TIMEOUT_SECONDS = 180


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def safe_member_name(name: str) -> bool:
    if not name or '\\' in name or name.startswith(('/', '\\')):
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and '..' not in path.parts and not (path.parts and ':' in path.parts[0])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--zip', dest='zip_path', help='Final package to reopen and audit.')
    parser.add_argument('--report', help='Markdown report output path.')
    args = parser.parse_args()
    package = __import__('json').loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    default_zip = ROOT.parent / f"Mes_Prieres_PWA_Prototype_v{package['version']}_Help_Audited.zip"
    source_zip = Path(args.zip_path).resolve() if args.zip_path else default_zip.resolve()
    if not source_zip.is_file():
        raise SystemExit(f'ZIP introuvable : {source_zip}')
    report_path = Path(args.report).resolve() if args.report else source_zip.with_name(source_zip.stem + '_Final_Reopen_Audit.md')
    started = datetime.now(timezone.utc)
    source_hash_before = sha256(source_zip)
    source_size_before = source_zip.stat().st_size
    failures: list[str] = []
    logs: list[str] = []

    with tempfile.TemporaryDirectory(prefix='mes-prieres-reopen-') as temp_dir_string:
        temp_dir = Path(temp_dir_string)
        immutable_zip = temp_dir / source_zip.name
        shutil.copy2(source_zip, immutable_zip)
        if sha256(immutable_zip) != source_hash_before or immutable_zip.stat().st_size != source_size_before:
            failures.append('La copie immutable de l’artefact ne correspond pas au ZIP source.')
        if zipfile.is_zipfile(immutable_zip) is False:
            failures.append('Le package n’est pas un ZIP valide.')
        if not failures:
            extract_dir = temp_dir / 'extracted'
            with zipfile.ZipFile(immutable_zip) as archive:
                if archive.testzip() is not None:
                    failures.append('Le ZIP contient une entrée compressée corrompue.')
                infos = archive.infolist()
                names = [info.filename for info in infos]
                if len(names) != len(set(names)):
                    failures.append('Le ZIP contient des chemins dupliqués.')
                if sum(info.file_size for info in infos) > MAX_UNCOMPRESSED_BYTES:
                    failures.append('Le ZIP dépasse la limite de taille extraite de sécurité.')
                roots = set()
                for info in infos:
                    if not safe_member_name(info.filename):
                        failures.append(f'Chemin ZIP non sûr : {info.filename}')
                    if info.file_size > MAX_MEMBER_BYTES:
                        failures.append(f'Entrée ZIP trop volumineuse : {info.filename}')
                    if stat.S_ISLNK(info.external_attr >> 16):
                        failures.append(f'Lien symbolique interdit dans le ZIP : {info.filename}')
                    if info.filename and not info.filename.endswith('/'):
                        roots.add(PurePosixPath(info.filename).parts[0])
                if len(roots) != 1:
                    failures.append(f'Le ZIP doit avoir une seule racine : {roots}')
                if not failures:
                    archive.extractall(extract_dir)
            if not failures:
                app_root = extract_dir / next(iter(roots))
                python_files = sorted(str(path.relative_to(app_root)) for path in app_root.rglob('*.py') if '__pycache__' not in path.parts)
                commands = [
                    ['node', '--check', 'app.js'],
                    ['node', '--check', 'sw.js'],
                    [sys.executable, '-m', 'py_compile', *python_files],
                    # Raw-package manifest audit must run before any generator or test is allowed to write.
                    [sys.executable, 'tools/release_audit.py'],
                    # Execute the same verification steps individually. This preserves per-gate
                    # evidence and avoids relying on an npm shell wrapper in the audit harness.
                    [sys.executable, 'tools/generate_corpus_js.py'],
                    [sys.executable, 'tools/generate_help_js.py'],
                    [sys.executable, 'tools/generate_sw.py', '--check'],
                    ['node', 'tools/audit.mjs'],
                    [sys.executable, 'tools/release_audit.py', '--prepackage'],
                    ['node', 'tests/sw_contract.mjs'],
                    [sys.executable, 'tests/integrity_guards.py'],
                    [sys.executable, 'tests/e2e.py'],
                    # Reassert manifest integrity after the full packaged test sequence.
                    [sys.executable, 'tools/release_audit.py'],
                ]
                for command in commands:
                    try:
                        result = subprocess.run(command, cwd=app_root, text=True, capture_output=True, timeout=COMMAND_TIMEOUT_SECONDS)
                        logs.append('$ ' + ' '.join(command) + '\n' + (result.stdout + result.stderr).strip())
                        if result.returncode:
                            failures.append(f'Échec dans le package rouvert : {" ".join(command)}')
                            break
                    except subprocess.TimeoutExpired as error:
                        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or '')
                        stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or '')
                        logs.append('$ ' + ' '.join(command) + f'\nTIMEOUT after {COMMAND_TIMEOUT_SECONDS}s\n' + (stdout + stderr).strip())
                        failures.append(f'Délai dépassé dans le package rouvert ({COMMAND_TIMEOUT_SECONDS}s) : {" ".join(command)}')
                        break
        if sha256(source_zip) != source_hash_before or source_zip.stat().st_size != source_size_before:
            failures.append('Le ZIP source a changé pendant l’audit ; identité non immuable.')
        if sha256(immutable_zip) != source_hash_before:
            failures.append('La copie immutable auditée a dérivé pendant l’audit.')

    completed = datetime.now(timezone.utc)
    status = 'PASS' if not failures else 'FAIL'
    report = [
        f"# Final Reopened Package Audit — Mes prières PWA V{package['version']}-help-audited",
        '',
        f'- **Status:** {status}',
        f'- **Package:** `{source_zip.name}`',
        f'- **Bytes:** {source_size_before}',
        f'- **SHA-256:** `{source_hash_before}`',
        f'- **Audit started (UTC):** {started.isoformat()}',
        f'- **Audit completed (UTC):** {completed.isoformat()}',
        '- **Identity method:** the source ZIP hash and size were recorded, copied into a fresh audit directory, verified before extraction and checked again after all commands. Only that immutable copy was extracted and audited.',
        '- **Runtime boundary:** executable browser-DOM and service-worker contract tests run from the extracted package. Actual URL navigation, service-worker registration and offline reload remain NOT RUN because this environment returns `ERR_BLOCKED_BY_ADMINISTRATOR` for Chromium navigation under `URLBlocklist=["*"]`.',
        '', '## Result', ''
    ]
    if failures:
        report.extend(f'- FAIL: {failure}' for failure in failures)
    else:
        report.append('- PASS: The immutable final ZIP has one safe root; its internal content manifest and metadata match its extracted files; the raw manifest passed before any generator ran, and all packaged executable checks passed. Real browser navigation, service-worker registration, offline reload and physical-device verification remain explicitly NOT RUN and are not implied by this PASS.')
    report.extend(['', '## Command evidence', ''])
    for log in logs:
        report.extend(['```text', log, '```', ''])
    report_path.write_text('\n'.join(report), encoding='utf-8')
    print(f'FINAL_REOPEN_AUDIT: {status}')
    print(f'Report: {report_path}')
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
