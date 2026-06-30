# QA report — Mes prières PWA Prototype V0.1.6-help-audited

## Scope and status

- Private functional prototype; **Not approved for public distribution**.
- The prayer corpus is unchanged and remains **À valider**.
- V0.1.6 adds only technical version visibility and an explicit manual update flow.
- `release.json` must match `package.json` and `app.js`; it is published with the runtime but is network-only in the service worker.
- The GitHub repository package revision R2 changes release assurance only: workflow action refs are full-SHA pinned, `github:package` runs source verification first, and the runtime/corpus remain V0.1.6-identical.

## Update behaviour

- Version v0.1.6 is shown on the main page and in Réglages.
- The user can choose **Vérifier les mises à jour**. A same-origin `release.json` response is validated, then compared semantically with the installed version.
- If a later version is accessible, the user chooses **Installer la mise à jour**. Only that explicit action sends `SKIP_WAITING` to a waiting service worker.
- The app never auto-activates an update during reading. Without a network connection, checking availability is unavailable; installed content remains usable offline.

## Automated-gate boundary

The browser-DOM harness validates the version display, current-version response, available-update state, malformed metadata rejection and settings interaction with a mocked same-origin response. The service-worker contract validates network-only handling of `release.json` and user-message-only `skipWaiting`.

Real browser navigation, service-worker registration, installation and airplane-mode reload remain **NOT RUN** because Chromium is governed here by `URLBlocklist=["*"]`. These are physical-device/permitted-browser gates, not passed claims.

GitHub Pages: manual, confirmation-gated Pages workflow.


## GitHub source-package assurance

- Every third-party action reference is a reviewed full commit SHA, not a mutable major tag.
- `npm run github:package` runs `npm run github:verify` before creating the repository ZIP.
- `tools/reopen_github_package_audit.py` audits a fresh immutable copy of a source package. This is separate from physical-device testing and does not turn the private-prototype boundary into public-release approval.
