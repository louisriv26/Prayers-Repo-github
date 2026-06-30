# Four-Pass Audit Record — Mes prières PWA Prototype V0.1.6-help-audited

## Evidence boundary

This in-package record is pre-reopen evidence only. The immutable external reopened-ZIP audit sidecar is the only artifact permitted to issue a final package decision. The prototype remains private and the corpus remains **À valider**.

## Pass 1 — Files versus build scripts

- `release.json` is the canonical same-origin release metadata; its version and app identity are required to match `package.json` and `app.js`.
- `tools/generate_sw.py` includes `release.json` in cache identity input but the service-worker template intentionally excludes it from the precache.
- Build, release, Pages and GitHub-package auditors require the metadata file and validate its identity.
- `data/prayers.json` and `data/help.json` remain canonical; their browser bundles are generated and checked non-destructively.

## Pass 2 — Runtime and package behavior

- The application displays the installed version on the main page and in Réglages.
- A manual check fetches `release.json` with cache bypass, validates its schema and compares semantic versions.
- A detected update is installed only after an explicit user action. The service worker reacts to `SKIP_WAITING` only through its message handler; it has no automatic `skipWaiting` during install.
- The service worker serves `release.json` from the network only and does not put it in the offline cache.

## Pass 3 — Active-report evidence consistency

- README, corpus status, QA report, this record, package metadata and content manifest must agree on V0.1.6, the unchanged corpus version, the private-prototype boundary and the canonical release root `mes-prieres-pwa-prototype-v0.1.6-help-audited`.
- help/bundle equality and the new `mises-a-jour` help section are checked by the source and reopened-package audit.

## Pass 4 — Stale or contradictory claims

- Active reports must not claim automatic update activation, completed physical-device installation, real service-worker registration or public-release approval.
- An unavailable network check must not be presented as “À jour”.
- The external reopened-ZIP audit sidecar is the only final PASS/FAIL authority for the final package.

GitHub Pages: manual confirmation-gated Pages workflow.


## GitHub repository package revision R2

R2 changes only source-control and release-assurance material: immutable GitHub Action pins,
self-verifying repository packaging, concrete runtime-baseline source identity and an
independent GitHub-source reopen auditor. The PWA runtime, `release.json`, prayer corpus and
help content remain V0.1.6-identical.
