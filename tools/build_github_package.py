#!/usr/bin/env python3
"""Create a deterministic source-control package for upload to GitHub.

The package contains the complete auditable source tree, including workflows and release
controls, while excluding generated Pages output and Git metadata. Before files are collected,
the builder regenerates the private-release manifest and metadata in a temporary release build
so the GitHub package cannot carry stale integrity evidence. In this project the private
prototype-release ZIP may contain the same source tree; the two deliverables are distinguished
by their intended use, filename and independent audit sidecar—not by an assumed binary
difference.
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from release_identity import canonical_release_root

ROOT = Path(__file__).resolve().parents[1]
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
IGNORED_TOP_LEVEL_DIRECTORIES = {'.git', 'site', '__pycache__'}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def files(exclude_absolute: set[Path]) -> list[Path]:
    result: list[Path] = []
    for path in ROOT.rglob('*'):
        if not path.is_file() or path.resolve() in exclude_absolute:
            continue
        relative = path.relative_to(ROOT)
        if not relative.parts or relative.parts[0] in IGNORED_TOP_LEVEL_DIRECTORIES:
            continue
        if '__pycache__' in relative.parts or path.suffix == '.pyc':
            continue
        result.append(relative)
    return sorted(result)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, help='Repository ZIP path, relative to source root unless absolute.')
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute():
        output = (ROOT / output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    # The repository package includes release manifests. Refresh them through the same
    # deterministic private-release evidence builder before collecting any source file.
    # The temporary ZIP is outside ROOT and is deleted immediately after evidence creation.
    with tempfile.TemporaryDirectory(prefix='mes-prieres-github-evidence-') as temp_string:
        evidence_zip = Path(temp_string) / 'release-evidence.zip'
        result = subprocess.run(
            [sys.executable, 'tools/build_release.py', '--output', str(evidence_zip)],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if result.returncode:
            raise SystemExit('Impossible de régénérer les preuves de release avant le package GitHub:\n' + (result.stdout + result.stderr).strip())
        if not evidence_zip.is_file():
            raise SystemExit('Le build de preuves de release n’a produit aucun ZIP temporaire.')

    output.unlink(missing_ok=True)
    package_files = files({output})
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
        for relative in package_files:
            info = zipfile.ZipInfo(f'{canonical_release_root(ROOT)}/{relative.as_posix()}', date_time=FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.flag_bits |= 0x800
            archive.writestr(info, (ROOT / relative).read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    print('GITHUB_PACKAGE_BUILD: PASS')
    print(f'Package: {output}')
    print(f'Bytes: {output.stat().st_size}')
    print(f'SHA256: {sha256(output)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
