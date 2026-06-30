#!/usr/bin/env python3
"""Static integrity audit for the source tree or a reopened release package."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from release_identity import canonical_release_filename, canonical_release_root

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_FROM_CONTENT_MANIFEST = {Path('audit/PACKAGE_METADATA.json'), Path('audit/package_file_manifest.txt')}
IGNORED_TOP_LEVEL_DIRECTORIES = {'.git', 'site', '__pycache__'}
ACTIVE_REPORTS = [Path('README.md'), Path('audit/QA_REPORT.md'), Path('audit/FOUR_PASS_AUDIT.md'), Path('docs/CORPUS_STATUS.md')]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def packaged_files(root: Path) -> list[Path]:
    return sorted(
        path.relative_to(root)
        for path in root.rglob('*')
        if path.is_file()
        and path.relative_to(root).parts
        and path.relative_to(root).parts[0] not in IGNORED_TOP_LEVEL_DIRECTORIES
        and '__pycache__' not in path.parts
        and path.suffix != '.pyc'
    )


def parse_content_manifest(path: Path) -> dict[Path, str]:
    parsed: dict[Path, str] = {}
    for line_no, line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1):
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not match:
            raise ValueError(f'Ligne de manifeste invalide ({line_no}) : {line}')
        relative = Path(match.group(2))
        if relative.is_absolute() or '..' in relative.parts or relative in parsed or '\\' in match.group(2):
            raise ValueError(f'Chemin de manifeste invalide ({line_no}) : {relative}')
        parsed[relative] = match.group(1)
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepackage', action='store_true', help='Do not require generated package metadata/manifest.')
    args = parser.parse_args()
    failures: list[str] = []

    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    corpus = json.loads((ROOT / 'data/prayers.json').read_text(encoding='utf-8'))
    help_data = json.loads((ROOT / 'data/help.json').read_text(encoding='utf-8'))
    release_metadata = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))
    expected_app_version = f"{package['version']}-help-audited-prototype"
    expected_root = canonical_release_root(ROOT)
    expected_package_name = canonical_release_filename(ROOT)

    required = [
        'index.html', 'app.js', 'styles.css', 'sw.js', 'sw.template.js', 'manifest.webmanifest',
        'data/prayers.json', 'data/prayers.js', 'data/help.json', 'data/help.js', 'release.json', 'package.json',
        'tools/audit.mjs', 'tools/generate_corpus_js.py', 'tools/generate_help_js.py', 'tools/generate_sw.py', 'tools/build_release.py',
        'tools/release_audit.py', 'tools/reopen_release_audit.py', 'tests/e2e.py', 'tests/sw_contract.mjs', 'tests/integrity_guards.py',
        'audit/QA_REPORT.md', 'audit/FOUR_PASS_AUDIT.md', 'docs/CORPUS_STATUS.md',
    ]
    for relative in required:
        if not (ROOT / relative).is_file():
            failures.append(f'Fichier requis absent : {relative}')

    app_js = (ROOT / 'app.js').read_text(encoding='utf-8')
    app_match = re.search(r"const APP_VERSION = '([^']+)'", app_js)
    if not app_match or app_match.group(1) != expected_app_version:
        failures.append(f"Version app.js incohérente : attendu {expected_app_version}")
    for required_symbol in ['window.APP_HELP', 'validateHelp', 'renderHelp', 'openHelp', 'helpBack']:
        if required_symbol not in app_js:
            failures.append(f'Fonction d’aide obligatoire absente : {required_symbol}')

    # Release audits must be read-only: a stale generated bundle must fail rather than be repaired before manifest validation.
    generated_corpus = subprocess.run([sys.executable, 'tools/generate_corpus_js.py', '--check'], cwd=ROOT, capture_output=True, text=True)
    if generated_corpus.returncode:
        failures.append('data/prayers.js n’est pas le résultat actuel de tools/generate_corpus_js.py --check.')
    generated_help = subprocess.run([sys.executable, 'tools/generate_help_js.py', '--check'], cwd=ROOT, capture_output=True, text=True)
    if generated_help.returncode:
        failures.append('data/help.js n’est pas le résultat actuel de tools/generate_help_js.py --check.')
    generated_sw = subprocess.run([sys.executable, 'tools/generate_sw.py', '--check'], cwd=ROOT, capture_output=True, text=True)
    if generated_sw.returncode:
        failures.append('sw.js n’est pas le résultat actuel de tools/generate_sw.py --check.')

    if release_metadata.get('schemaVersion') != 1 or release_metadata.get('version') != package['version'] or release_metadata.get('appVersion') != expected_app_version:
        failures.append('release.json ne correspond pas à l’identité de l’application.')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(release_metadata.get('publishedAt', ''))) or not str(release_metadata.get('releaseNotes', '')).strip():
        failures.append('release.json contient une date ou des notes de version invalides.')

    if not isinstance(corpus.get('prayers'), list) or not corpus['prayers']:
        failures.append('Corpus vide ou invalide.')
    if corpus.get('corpusVersion') != '0.1.0-prototype':
        failures.append('La version du corpus a changé sans migration éditoriale déclarée.')
    if corpus.get('notImportedBecauseTextMissing') != ['Notre Père', 'Je vous salue Marie']:
        failures.append('La déclaration des prières non importées est incohérente.')
    if any(prayer.get('sourceStatus') == 'Validé pour diffusion publique' for prayer in corpus['prayers']):
        failures.append('Le corpus prototype ne peut pas être présenté comme validé pour diffusion publique.')

    if help_data.get('helpVersion') != '1.0.0' or help_data.get('language') != 'fr' or not isinstance(help_data.get('sections'), list):
        failures.append('Métadonnées d’aide invalides.')
    required_help_ids = {'essentiel', 'demarrer', 'listes', 'organiser', 'repertoire', 'lecture', 'reglages', 'sauvegarde', 'installation', 'mises-a-jour', 'contenu-confidentialite', 'depannage', 'limites'}
    actual_help_ids = {section.get('id') for section in help_data.get('sections', []) if isinstance(section, dict)}
    if not required_help_ids.issubset(actual_help_ids):
        failures.append('L’aide ne contient pas toutes les sections verrouillées.')
    help_text = json.dumps(help_data, ensure_ascii=False)
    for forbidden in ['diffusion publique approuvée', 'vérifications matérielles sont accomplies']:
        if forbidden in help_text:
            failures.append(f'Claim interdit dans l’aide : {forbidden}')
    for required_phrase in ['prototype privé', 'ne synchronise pas automatiquement', 'À valider', 'doit encore être vérifié', 'Vérifier les mises à jour']:
        if required_phrase not in help_text:
            failures.append(f'Limite requise absente de l’aide : {required_phrase}')

    reports = {path: (ROOT / path).read_text(encoding='utf-8') for path in ACTIVE_REPORTS}
    joined_reports = '\n'.join(reports.values())
    for phrase in ['V0.1.5', '0.1.5-help-audited', 'V0.1.4', '0.1.4-help-audited', 'V0.1.3', '0.1.3-help-audited', 'V0.1.2', '0.1.2-deep-audited', 'V0.1.1', '0.1.1-audited-prototype', 'test e2e démarre son propre serveur', 'FINAL_PACKAGE_REOPEN_GATE = FAIL', 'false positive', 'PASS despite']:
        if phrase in joined_reports:
            failures.append(f'Claim obsolète ou contradictoire dans un rapport actif : {phrase}')
    if expected_root not in reports[Path('README.md')] or expected_root not in reports[Path('audit/FOUR_PASS_AUDIT.md')]:
        failures.append('Documentation de chemin/version obsolète.')
    if f'V{package["version"]}-help-audited' not in reports[Path('README.md')] or f'V{package["version"]}-help-audited' not in reports[Path('docs/CORPUS_STATUS.md')]:
        failures.append('Documentation de version obsolète.')
    if 'Not approved for public distribution' not in reports[Path('audit/QA_REPORT.md')]:
        failures.append('QA_REPORT ne contient pas le verrou de non-diffusion publique.')
    if 'physical-device' not in reports[Path('audit/QA_REPORT.md')] or 'URLBlocklist=["*"]' not in reports[Path('audit/QA_REPORT.md')]:
        failures.append('QA_REPORT ne déclare pas précisément la limite de test matériel/navigateur réel.')
    if 'ne démarre pas de serveur' not in reports[Path('README.md')]:
        failures.append('README ne décrit pas correctement la limite du test E2E.')
    if 'external reopened-ZIP audit sidecar' not in reports[Path('audit/FOUR_PASS_AUDIT.md')]:
        failures.append('FOUR_PASS_AUDIT ne distingue pas l’état interne pré-reopen du verdict externe.')
    if 'Aide intégrée' not in reports[Path('README.md')] or 'help/bundle equality' not in reports[Path('audit/FOUR_PASS_AUDIT.md')]:
        failures.append('Les rapports actifs ne documentent pas correctement la fonctionnalité Aide.')
    if 'mise à jour' not in reports[Path('README.md')].lower() or 'release.json' not in reports[Path('audit/FOUR_PASS_AUDIT.md')]:
        failures.append('La documentation active ne décrit pas le mécanisme de version/mise à jour.')
    if 'search-debug.png' in '\n'.join(str(path) for path in packaged_files(ROOT)) or 'search-debug.png' in joined_reports:
        failures.append('Artefact/référence visuel interne obsolète détecté.')

    manifest_path = ROOT / 'audit/package_file_manifest.txt'
    metadata_path = ROOT / 'audit/PACKAGE_METADATA.json'
    if not args.prepackage:
        if not manifest_path.is_file() or not metadata_path.is_file():
            failures.append('Manifest ou metadata de package absent.')
        else:
            try:
                manifest = parse_content_manifest(manifest_path)
                actual = {relative: sha256(ROOT / relative) for relative in packaged_files(ROOT) if relative not in EXCLUDED_FROM_CONTENT_MANIFEST}
                if set(manifest) != set(actual):
                    missing = sorted(str(item) for item in set(actual) - set(manifest))
                    extra = sorted(str(item) for item in set(manifest) - set(actual))
                    if missing: failures.append(f'Manifest incomplet : {", ".join(missing)}')
                    if extra: failures.append(f'Manifest contient des fichiers absents : {", ".join(extra)}')
                for relative, expected_hash in manifest.items():
                    if actual.get(relative) != expected_hash:
                        failures.append(f'Hash de manifeste invalide : {relative}')
                metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
                if metadata.get('package_name') != expected_package_name: failures.append('PACKAGE_METADATA package_name incohérent.')
                if metadata.get('package_root') != expected_root: failures.append('PACKAGE_METADATA package_root incohérent.')
                if metadata.get('app_version') != expected_app_version: failures.append('PACKAGE_METADATA app_version incohérent.')
                if metadata.get('corpus_version') != corpus.get('corpusVersion'): failures.append('PACKAGE_METADATA corpus_version incohérent.')
                if metadata.get('release_version') != release_metadata.get('version'): failures.append('PACKAGE_METADATA release_version incohérent.')
                if metadata.get('release_published_at') != release_metadata.get('publishedAt'): failures.append('PACKAGE_METADATA release_published_at incohérent.')
                if metadata.get('content_manifest_sha256') != sha256(manifest_path): failures.append('PACKAGE_METADATA content_manifest_sha256 incohérent.')
                if metadata.get('manifest_scope') != 'All package files except audit/PACKAGE_METADATA.json and audit/package_file_manifest.txt.': failures.append('PACKAGE_METADATA manifest_scope incohérent.')
                if metadata.get('package_status') != 'PACKAGE_BUILT_AWAITING_EXTERNAL_REOPEN_AUDIT': failures.append('PACKAGE_METADATA package_status incohérent.')
                if metadata.get('build_format') != 'deterministic-zip-v1': failures.append('PACKAGE_METADATA build_format incohérent.')
            except Exception as error:  # noqa: BLE001
                failures.append(f'Impossible de valider le manifeste/metadata : {error}')

    if failures:
        print('RELEASE_AUDIT: FAIL')
        for failure in failures:
            print(f'- {failure}')
        return 1
    print('RELEASE_AUDIT: PASS')
    print(f'App version: {expected_app_version}')
    print(f'Corpus: {len(corpus["prayers"])} prières')
    print(f'Aide: {len(help_data["sections"])} sections')
    print(f'Package manifest: {"present" if manifest_path.is_file() else "prepackage"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
