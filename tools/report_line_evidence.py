#!/usr/bin/env python3
"""Line-by-line evidence audit for active user-facing reports and release documentation."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORTS = [
    Path('README.md'),
    Path('audit/QA_REPORT.md'),
    Path('audit/FOUR_PASS_AUDIT.md'),
    Path('docs/CORPUS_STATUS.md'),
    Path('docs/GITHUB_SETUP.md'),
]
RUNTIME_FILES = (
    Path('index.html'), Path('styles.css'), Path('app.js'), Path('manifest.webmanifest'), Path('sw.template.js'), Path('sw.js'),
    Path('data/prayers.json'), Path('data/prayers.js'), Path('data/help.json'), Path('data/help.js'), Path('release.json'),
    Path('icons/icon.svg'), Path('icons/icon-192.png'), Path('icons/icon-512.png'),
)
EXPECTED_PINS = {
    'actions/checkout': 'df4cb1c069e1874edd31b4311f1884172cec0e10',
    'actions/setup-node': '48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
    'actions/setup-python': 'a309ff8b426b58ec0e2a45f0f869d46889d02405',
    'actions/configure-pages': '983d7736d9b0ae728b81ab479565c72886d7745b',
    'actions/upload-pages-artifact': '7b1f4a764d45c48632c6b24a0339c27f5614fb0b',
    'actions/deploy-pages': 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e',
}
STALE = ('V0.1.5', 'V0.1.4', 'V0.1.3', 'V0.1.2', 'V0.1.1', '0.1.5-help-audited', '0.1.4-help-audited', '0.1.3-help-audited', '0.1.2-deep-audited', '0.1.1-audited-prototype')


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def facts() -> dict[str, bool]:
    package = json.loads((ROOT/'package.json').read_text(encoding='utf-8'))
    release = json.loads((ROOT/'release.json').read_text(encoding='utf-8'))
    corpus = json.loads((ROOT/'data/prayers.json').read_text(encoding='utf-8'))
    help_data = json.loads((ROOT/'data/help.json').read_text(encoding='utf-8'))
    baseline = json.loads((ROOT/'audit/RUNTIME_BASELINE_v0.1.6.json').read_text(encoding='utf-8'))
    app = (ROOT/'app.js').read_text(encoding='utf-8')
    sw = (ROOT/'sw.js').read_text(encoding='utf-8')
    verify = (ROOT/'.github/workflows/verify.yml').read_text(encoding='utf-8')
    deploy = (ROOT/'.github/workflows/deploy-pages.yml').read_text(encoding='utf-8')
    combined = verify + '\n' + deploy
    runtime_hashes_ok = all(baseline.get('runtime_files', {}).get(item.as_posix()) == sha256(ROOT/item) for item in RUNTIME_FILES)
    action_refs = re.findall(r'uses:\s*([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)', combined)
    pins_ok = bool(action_refs) and all(
        ref == EXPECTED_PINS.get(action) and bool(re.fullmatch(r'[0-9a-f]{40}', ref))
        for action, ref in action_refs
    ) and all(any(action == expected for action, _ in action_refs) for expected in EXPECTED_PINS)
    setup = (ROOT/'docs/GITHUB_SETUP.md').read_text(encoding='utf-8')
    numeric = [int(value) for value in re.findall(r'^##\s+(\d+)\.', setup, flags=re.MULTILINE)]
    return {
        'version': package.get('version') == '0.1.6' and release.get('version') == '0.1.6' and "const APP_RELEASE_VERSION = '0.1.6'" in app,
        'runtime': runtime_hashes_ok,
        'corpus': len(corpus.get('prayers', [])) == 7 and corpus.get('corpusVersion') == '0.1.0-prototype',
        'help': len(help_data.get('sections', [])) == 13 and 'window.APP_HELP' in app,
        'update': all(token in app for token in ['Vérifier les mises à jour', 'Installer la mise à jour', 'release.json']) and 'release.json' in sw,
        'manual_pages': 'workflow_dispatch:' in deploy and 'confirm_public_pages:' in deploy and not re.search(r'^\s*push:', deploy, re.MULTILINE),
        'action_pins': pins_ok,
        'package_guard': 'npm run github:verify' in package.get('scripts', {}).get('github:package', '') and 'tools/build_release.py' in (ROOT/'tools/build_github_package.py').read_text(encoding='utf-8'),
        'boundaries': 'NOT RUN' in (ROOT/'audit/QA_REPORT.md').read_text(encoding='utf-8') and 'URLBlocklist=["*"]' in (ROOT/'audit/QA_REPORT.md').read_text(encoding='utf-8'),
        'setup_headings': numeric == list(range(1, 10)),
        'baseline_lineage': bool(re.fullmatch(r'[0-9a-f]{64}', str(baseline.get('source_release_sha256', '')))) and baseline.get('source_release_bytes') == 97329,
    }


def line_category(line: str) -> tuple[str, list[str]]:
    lowered = line.lower()
    if line.startswith('#'):
        return 'Structure', []
    if any(token in lowered for token in ['v0.1.6', '0.1.6', 'version installée', 'version de l’application']):
        return 'Version', ['version']
    if any(token in lowered for token in ['corpus', 'prière', 'prières']) and ('7' in line or 'inchangé' in lowered or 'à valider' in lowered):
        return 'Corpus', ['corpus', 'runtime']
    if any(token in lowered for token in ['aide', 'help']) and ('13' in line or 'bundle' in lowered or 'hors ligne' in lowered):
        return 'Aide', ['help']
    if any(token in lowered for token in ['mise à jour', 'release.json', 'installer la mise', 'vérifier les mises']):
        return 'Mise à jour', ['update', 'version']
    if any(token in lowered for token in ['github pages', 'workflow', 'déploiement', 'confirm_public_pages', 'publique']):
        return 'GitHub Pages', ['manual_pages']
    if any(token in lowered for token in ['sha', 'action', 'commit', 'tag mutable']):
        return 'Supply chain', ['action_pins']
    if any(token in lowered for token in ['github:package', 'github:verify', 'package github', 'repository package']):
        return 'Package GitHub', ['package_guard']
    if any(token in lowered for token in ['not run', 'urlblocklist', 'physical-device', 'appareil', 'airplane', 'hors connexion']):
        return 'Limite de test', ['boundaries']
    if any(token in lowered for token in ['baseline', 'empreinte', 'sha-256', 'runtime']):
        return 'Baseline', ['runtime', 'baseline_lineage']
    return 'Contexte / instruction', []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', help='Optional external Markdown evidence mapping.')
    args = parser.parse_args()
    failures: list[str] = []
    all_lines: list[tuple[str, int, str]] = []
    for report in REPORTS:
        target = ROOT/report
        if not target.is_file():
            failures.append(f'Rapport actif absent : {report}')
            continue
        for number, raw in enumerate(target.read_text(encoding='utf-8').splitlines(), start=1):
            if raw.strip():
                all_lines.append((report.as_posix(), number, raw.rstrip()))
    current = facts()
    for key, value in current.items():
        if not value:
            failures.append(f'Évidence de rapport invalide : {key}')
    joined = '\n'.join(line for _, _, line in all_lines)
    for phrase in STALE:
        if phrase in joined:
            failures.append(f'Référence obsolète détectée : {phrase}')
    records = []
    for file_name, number, line in all_lines:
        category, evidence = line_category(line)
        ok = all(current.get(key, False) for key in evidence)
        if not ok:
            failures.append(f'Ligne sans preuve actuelle : {file_name}:{number}')
        records.append((file_name, number, category, ', '.join(evidence) if evidence else 'Structure / instruction non factuelle', 'PASS' if ok else 'FAIL', line))
    if args.report:
        out = Path(args.report).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        rendered = [
            '# Active Report Line-by-Line Evidence Audit', '',
            f'- **Nonblank lines reviewed:** {len(records)}',
            f'- **Status:** {"PASS" if not failures else "FAIL"}',
            '- **Evidence keys:** version, runtime, corpus, help, update, manual_pages, action_pins, package_guard, boundaries, setup_headings, baseline_lineage.',
            '', '## Line mapping', '', '| # | File:line | Class | Current evidence | Result | Text |', '|---:|---|---|---|---|---|'
        ]
        for idx, (file_name, number, category, evidence, result, line) in enumerate(records, start=1):
            safe = line.replace('|', '\\|')
            rendered.append(f'| {idx} | `{file_name}:{number}` | {category} | {evidence} | {result} | {safe} |')
        rendered.extend(['', '## Findings', ''])
        rendered.extend(f'- FAIL: {item}' for item in failures) if failures else rendered.append('- PASS: Every nonblank active-report line was mapped to current evidence or classified as document structure/instruction; no stale version reference or unsupported active release claim was found.')
        out.write_text('\n'.join(rendered) + '\n', encoding='utf-8')
    if failures:
        print('REPORT_LINE_EVIDENCE: FAIL')
        for item in failures:
            print(f'- {item}')
        return 1
    print('REPORT_LINE_EVIDENCE: PASS')
    print(f'Nonblank active-report lines reviewed: {len(records)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
