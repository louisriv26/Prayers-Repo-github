#!/usr/bin/env python3
"""Canonical identifiers for reproducible app-release packages.

A Git checkout may live in any directory name. Release ZIPs retain a stable internal
root so their manifests and reopened-package audits remain comparable.
"""
from __future__ import annotations

import json
from pathlib import Path


def package_version(root: Path) -> str:
    return json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']


def canonical_release_root(root: Path) -> str:
    return f"mes-prieres-pwa-prototype-v{package_version(root)}-help-audited"


def canonical_release_filename(root: Path) -> str:
    return f"Mes_Prieres_PWA_Prototype_v{package_version(root)}_Help_Audited.zip"
