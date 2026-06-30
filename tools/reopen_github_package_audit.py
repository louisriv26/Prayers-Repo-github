#!/usr/bin/env python3
"""Reopen a GitHub source package in a fresh immutable directory and audit only that copy."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MAX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024
MAX_MEMBER_BYTES = 6 * 1024 * 1024
COMMAND_TIMEOUT_SECONDS = 240


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


def append_log(logs: list[str], command: list[str], result: subprocess.CompletedProcess[str] | None = None, error: Exception | None = None) -> None:
    entry = '$ ' + ' '.join(command)
    if result is not None:
        entry += '\n' + (result.stdout + result.stderr).strip()
    if error is not None:
        entry += '\n' + repr(error)
    logs.append(entry)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--zip', dest='zip_path', required=True, help='GitHub repository ZIP to reopen and audit.')
    parser.add_argument('--report', required=True, help='Markdown report output path.')
    args = parser.parse_args()
    source_zip = Path(args.zip_path).resolve()
    report_path = Path(args.report).resolve()
    if not source_zip.is_file():
        raise SystemExit(f'ZIP introuvable : {source_zip}')
    report_path.parent.mkdir(parents=True, exist_ok=True)

    started = datetime.now(timezone.utc)
    source_hash = sha256(source_zip)
    source_size = source_zip.stat().st_size
    failures: list[str] = []
    logs: list[str] = []
    expected_root: str | None = None

    with tempfile.TemporaryDirectory(prefix='mes-prieres-github-reopen-') as temp_string:
        temp = Path(temp_string)
        immutable = temp / source_zip.name
        shutil.copy2(source_zip, immutable)
        if sha256(immutable) != source_hash or immutable.stat().st_size != source_size:
            failures.append('La copie immutable ne correspond pas au ZIP GitHub fourni.')
        if not zipfile.is_zipfile(immutable):
            failures.append('Le package GitHub n’est pas un ZIP valide.')
        if not failures:
            extract = temp / 'extracted'
            with zipfile.ZipFile(immutable) as archive:
                if archive.testzip() is not None:
                    failures.append('Le ZIP GitHub contient une entrée corrompue.')
                infos = archive.infolist()
                names = [info.filename for info in infos]
                if len(names) != len(set(names)):
                    failures.append('Le ZIP GitHub contient des chemins dupliqués.')
                if sum(info.file_size for info in infos) > MAX_UNCOMPRESSED_BYTES:
                    failures.append('Le ZIP GitHub dépasse la limite de sécurité extraite.')
                roots = set()
                for info in infos:
                    if not safe_member_name(info.filename):
                        failures.append(f'Chemin ZIP non sûr : {info.filename}')
                    if info.file_size > MAX_MEMBER_BYTES:
                        failures.append(f'Entrée ZIP trop volumineuse : {info.filename}')
                    if stat.S_ISLNK(info.external_attr >> 16):
                        failures.append(f'Lien symbolique interdit : {info.filename}')
                    if info.filename and not info.filename.endswith('/'):
                        roots.add(PurePosixPath(info.filename).parts[0])
                if len(roots) != 1:
                    failures.append(f'Le ZIP GitHub doit avoir une seule racine : {roots}')
                if not failures:
                    expected_root = next(iter(roots))
                    archive.extractall(extract)
            if not failures:
                package_root = extract / expected_root
                prohibited = [package_root / 'site', package_root / '.git']
                for path in prohibited:
                    if path.exists():
                        failures.append(f'Le package GitHub contient un artefact interdit : {path.name}')
                py_files = sorted(str(path.relative_to(package_root)) for path in package_root.rglob('*.py') if '__pycache__' not in path.parts)
                commands = [
                    ['node', '--check', 'app.js'],
                    ['node', '--check', 'sw.js'],
                    [sys.executable, '-m', 'py_compile', *py_files],
                    # Must validate the existing raw package before anything is generated.
                    [sys.executable, 'tools/release_audit.py'],
                    [sys.executable, 'tools/github_package_audit.py'],
                    # Run the github:verify contract step by step so each packaged gate has
                    # independent evidence and long browser-DOM work cannot hide progress.
                    [sys.executable, 'tools/generate_corpus_js.py', '--check'],
                    [sys.executable, 'tools/generate_help_js.py', '--check'],
                    [sys.executable, 'tools/generate_sw.py', '--check'],
                    ['node', 'tools/audit.mjs'],
                    [sys.executable, 'tools/release_audit.py', '--prepackage'],
                    ['node', 'tests/sw_contract.mjs'],
                    [sys.executable, 'tests/integrity_guards.py'],
                    [sys.executable, 'tests/e2e.py'],
                    [sys.executable, 'tools/prepare_pages_site.py', '--output', 'site'],
                    [sys.executable, 'tools/validate_pages_site.py', '--site', 'site'],
                    [sys.executable, 'tools/github_package_audit.py', '--site', 'site'],
                    [sys.executable, 'tools/report_line_evidence.py'],
                    # Reassert raw manifest integrity after all executable checks.
                    [sys.executable, 'tools/release_audit.py'],
                    [sys.executable, 'tools/github_package_audit.py', '--site', 'site'],
                ]
                for command in commands:
                    try:
                        print('GITHUB_REOPEN_STEP: ' + ' '.join(command), flush=True)
                        stream_live = command == [sys.executable, 'tests/e2e.py']
                        if stream_live:
                            logs.append('$ ' + ' '.join(command) + '\n[stdout/stderr streamed live to retain audit liveness]')
                            result = subprocess.run(command, cwd=package_root, text=True, timeout=COMMAND_TIMEOUT_SECONDS)
                        else:
                            result = subprocess.run(command, cwd=package_root, text=True, capture_output=True, timeout=COMMAND_TIMEOUT_SECONDS)
                            append_log(logs, command, result=result)
                        print(f'GITHUB_REOPEN_STEP_RESULT: {result.returncode}', flush=True)
                        if result.returncode:
                            failures.append(f'Échec dans le package GitHub rouvert : {" ".join(command)}')
                            break
                    except subprocess.TimeoutExpired as error:
                        append_log(logs, command, error=error)
                        failures.append(f'Délai dépassé dans le package GitHub rouvert ({COMMAND_TIMEOUT_SECONDS}s) : {" ".join(command)}')
                        break
        if sha256(source_zip) != source_hash or source_zip.stat().st_size != source_size:
            failures.append('Le ZIP GitHub source a changé pendant l’audit.')
        if immutable.exists() and sha256(immutable) != source_hash:
            failures.append('La copie immutable auditée a dérivé pendant l’audit.')

    completed = datetime.now(timezone.utc)
    status = 'PASS' if not failures else 'FAIL'
    lines = [
        '# Final Reopened GitHub Package Audit — Mes prières',
        '',
        f'- **Status:** {status}',
        f'- **Package:** `{source_zip.name}`',
        f'- **Bytes:** {source_size}',
        f'- **SHA-256:** `{source_hash}`',
        f'- **Internal root:** `{expected_root or "UNRESOLVED"}`',
        f'- **Audit started (UTC):** {started.isoformat()}',
        f'- **Audit completed (UTC):** {completed.isoformat()}',
        '- **Identity method:** source ZIP hash and size were recorded, copied into a fresh audit directory, checked before extraction and rechecked after all commands. Only that immutable copy was extracted and audited.',
        '- **Runtime boundary:** source and Pages-artifact tests run from the extracted package. Actual browser navigation, service-worker registration, installation, real-origin IndexedDB and airplane-mode reload remain NOT RUN in this environment.',
        '', '## Result', ''
    ]
    if failures:
        lines.extend(f'- FAIL: {item}' for item in failures)
    else:
        lines.append('- PASS: The immutable source package has a safe single root; raw manifest validation passed before generators, all GitHub-source checks passed from the extracted copy, and the post-test manifest recheck still matches. This PASS does not imply physical-device or real-browser PWA execution.')
    lines.extend(['', '## Command evidence', ''])
    for log in logs:
        lines.extend(['```text', log, '```', ''])
    report_path.write_text('\n'.join(lines), encoding='utf-8')
    print(f'GITHUB_FINAL_REOPEN_AUDIT: {status}')
    print(f'Report: {report_path}')
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
