#!/usr/bin/env python3
"""Build a reproducible-source release ZIP with generated integrity metadata."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

from release_identity import canonical_release_filename, canonical_release_root

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_FROM_CONTENT_MANIFEST = {Path('audit/PACKAGE_METADATA.json'), Path('audit/package_file_manifest.txt')}
IGNORED_TOP_LEVEL_DIRECTORIES = {'.git', 'site', '__pycache__'}
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
COMMAND_TIMEOUT_SECONDS = 120


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def source_files(exclude_absolute: set[Path] | None = None) -> list[Path]:
    excluded = {path.resolve() for path in (exclude_absolute or set())}
    return sorted(
        path.relative_to(ROOT)
        for path in ROOT.rglob('*')
        if path.is_file()
        and path.resolve() not in excluded
        and not (path.relative_to(ROOT).parts and path.relative_to(ROOT).parts[0] in IGNORED_TOP_LEVEL_DIRECTORIES)
        and '__pycache__' not in path.parts
        and path.suffix != '.pyc'
    )


def run(command: list[str]) -> None:
    result = subprocess.run(command, cwd=ROOT, text=True, timeout=COMMAND_TIMEOUT_SECONDS)
    if result.returncode:
        raise SystemExit(result.returncode)


def write_reproducible_zip(output: Path, files: list[Path]) -> None:
    root_name = canonical_release_root(ROOT)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
        for relative in files:
            info = zipfile.ZipInfo(f'{root_name}/{relative.as_posix()}', date_time=FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.flag_bits |= 0x800  # UTF-8 path flag
            archive.writestr(info, (ROOT / relative).read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, help='ZIP output path, relative to the source root unless absolute.')
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute():
        output = (ROOT / output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    # Canonical runtime artifacts must be fresh before integrity material is created.
    run([sys.executable, 'tools/generate_corpus_js.py'])
    run([sys.executable, 'tools/generate_help_js.py'])
    run([sys.executable, 'tools/generate_sw.py'])
    run(['node', 'tools/audit.mjs'])
    run([sys.executable, 'tools/release_audit.py', '--prepackage'])

    audit_dir = ROOT / 'audit'
    audit_dir.mkdir(exist_ok=True)
    manifest_path = audit_dir / 'package_file_manifest.txt'
    metadata_path = audit_dir / 'PACKAGE_METADATA.json'
    manifest_path.unlink(missing_ok=True)
    metadata_path.unlink(missing_ok=True)

    output_exclusion = {output} if output.is_relative_to(ROOT) else set()
    manifest_entries = []
    for relative in source_files(output_exclusion):
        if relative in EXCLUDED_FROM_CONTENT_MANIFEST:
            continue
        manifest_entries.append(f'{sha256(ROOT / relative)}  {relative.as_posix()}')
    manifest_path.write_text(
        '# SHA-256 content manifest. Scope: all package files except audit/PACKAGE_METADATA.json and audit/package_file_manifest.txt.\n'
        + '\n'.join(manifest_entries) + '\n',
        encoding='utf-8'
    )

    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    corpus = json.loads((ROOT / 'data/prayers.json').read_text(encoding='utf-8'))
    release_metadata = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))
    metadata = {
        'package_name': canonical_release_filename(ROOT),
        'package_root': canonical_release_root(ROOT),
        'app_version': f"{package['version']}-help-audited-prototype",
        'corpus_version': corpus['corpusVersion'],
        'release_version': release_metadata['version'],
        'release_published_at': release_metadata['publishedAt'],
        'delivery_scope': 'Private functional prototype. Not approved for public distribution.',
        'package_status': 'PACKAGE_BUILT_AWAITING_EXTERNAL_REOPEN_AUDIT',
        'file_manifest': 'audit/package_file_manifest.txt',
        'manifest_scope': 'All package files except audit/PACKAGE_METADATA.json and audit/package_file_manifest.txt.',
        'content_manifest_sha256': sha256(manifest_path),
        'build_script': 'tools/build_release.py',
        'build_format': 'deterministic-zip-v1',
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # Final source-tree integrity check includes generated evidence metadata.
    run([sys.executable, 'tools/release_audit.py'])

    if output.exists():
        output.unlink()
    files = source_files(output_exclusion)
    write_reproducible_zip(output, files)
    print('RELEASE_BUILD: PASS')
    print(f'Package: {output}')
    print(f'Bytes: {output.stat().st_size}')
    print(f'SHA256: {sha256(output)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
