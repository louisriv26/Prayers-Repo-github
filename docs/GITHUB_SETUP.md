# GitHub setup and controlled Pages deployment

## Purpose

This repository is prepared for GitHub-based source control, continuous verification and a
**manual, deliberately gated** GitHub Pages deployment. The deployed `site/` artifact
contains only the application runtime; it excludes documentation, tests, audit reports,
build tools and workflow files.

## Publication boundary — read before deploying

The prototype corpus is not yet cleared for public distribution. GitHub Pages sites are
publicly reachable even when the source repository is private, subject to GitHub plan and
organisation settings. Keep the repository private and do **not** run the deployment
workflow until the corpus’s text, sources, provenance and rights have been approved for
this use.

The deployment workflow is intentionally manual-only. It requires an explicit
`confirm_public_pages` confirmation and does not deploy on a push to `main`.

## 1. Create the repository

1. Create a **private** repository, for example `mes-prieres-pwa`.
2. Do not select GitHub’s “Add a README”, licence or `.gitignore` options; this package
   already supplies the required files.
3. Unzip this package and open a terminal in the extracted folder.

```bash
git init
git branch -M main
git add .
git commit -m "Initial audited prototype v0.1.6"
git remote add origin <YOUR_GITHUB_REPOSITORY_URL>
git push -u origin main
```

The working directory may have any name after cloning. Release ZIPs retain the canonical
internal root `mes-prieres-pwa-prototype-v0.1.6-help-audited` automatically.

## 2. Verify before any deployment

The `Verify source` workflow runs for pull requests and pushes to `main`. It checks:

- canonical corpus/help/service-worker bundles are current;
- static release integrity, service-worker behaviour and browser-DOM interactions;
- GitHub Pages artifact preparation and validation;
- the runtime file baseline inherited from the audited v0.1.6 prototype;
- the fact that no documentation, tests, audit reports or build scripts enter `site/`.

The workflow installs the locked Playwright test dependency and Chromium before executing
the browser-DOM suite.

Recommended repository protection:

- protect `main`;
- require the `Verify source` check before merging;
- restrict direct pushes to `main`;
- require a pull request review for later changes to `data/prayers.json`, `data/help.json`,
  `app.js`, `.github/workflows/` and `tools/`.

## 3. Enable GitHub Pages only when content approval permits publication

1. In the repository, open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Create or review the `github-pages` environment. Add a deployment protection rule that
   restricts deployment to `main` and, where appropriate, requires an approver.
4. Open **Actions → Deploy prototype to GitHub Pages → Run workflow**.
5. Explicitly confirm `confirm_public_pages`.
6. Record the deployment URL shown by the workflow. Test only that URL; do not assume a
   GitHub Pages project URL in advance.

The workflow deploys only the generated `site/` directory. It uses the current GitHub
Pages custom-workflow pattern: Pages configuration, a Pages artifact upload, and a separate
deployment job targeting the `github-pages` environment.

## 4. Publish and verify an application update

For every later application release, update `package.json`, `app.js`, `release.json`, the release documentation and the audit baseline together, then run the full verification suite. `release.json` is the same-origin metadata file used by the installed app to determine the currently accessible version.

After a Pages deployment is complete:

1. Open the installed app while online.
2. Confirm that the bottom version line and **Réglages → Mise à jour** show the installed version.
3. Choose **Vérifier les mises à jour**.
4. When a newer release is reported, choose **Installer la mise à jour**. The service worker activates only after that explicit action, then the app reloads.
5. Confirm that lists, order and reading settings are still present after the reload.

`release.json` is deliberately excluded from the offline cache so an old installed app does not report itself as current from stale local cache data. A network connection is required to check; this does not affect offline prayer reading.

## 5. Test the actual installed PWA

Before accepting any public or wider distribution, record device model, operating-system
version and browser for each test:

1. Open the Pages URL over HTTPS.
2. Add the app to the home screen on iPhone/iPad and install it on Android where offered.
3. Open it once while online, close it, then test an airplane-mode reload.
4. Create and reorder lists; add one prayer to multiple lists; confirm persistence after a
   full close and reopen.
5. Read a long prayer, scroll, open Help and verify that return restores the reading place.
6. Test large text, dark mode, portrait and landscape.
7. Export and restore the personal configuration on a second device.
8. Record any failure with a screenshot or video and the exact workflow/app version.

These physical-device checks were not executed in the development environment and remain a
release gate.

## 6. Day-to-day development

```bash
npm run verify:ci
npm run pages:prepare
npm run pages:verify
python3 tools/github_package_audit.py --site site
npm run github:package
```

`site/` is generated and ignored by Git. Never edit it manually. Edit canonical source
files (`data/prayers.json`, `data/help.json`, application source) and then run the checks.

## 7. Content-change discipline

Do not add a prayer to `data/prayers.json` until its exact source, wording, attribution and
rights status are recorded. Do not change an existing prayer identifier merely to correct
its title or text; identifiers are user-state references. Any future editorial migration
must preserve or explicitly map user lists.

## 8. Action maintenance

Every third-party GitHub Action in `.github/workflows/` is pinned to a full commit SHA,
with the reviewed release version retained as an inline comment. This prevents a mutable
tag from changing the code executed by a future workflow run without a repository change.

When updating an action, review its upstream release and its full commit SHA, update both
the SHA and the human-readable release comment, then run `npm run github:verify` and build
a fresh GitHub repository package. Do not replace a full SHA with a major-version tag.

## 9. Règle de sécurité

**ne pas déclencher un déploiement Pages** avant validation éditoriale complète, décision explicite de publication et compréhension du caractère potentiellement public du site. Exécutez d’abord `npm run github:verify`.


## Repository package revision

The PWA runtime remains **v0.1.6**. The GitHub repository bundle may carry a later
repository-audit revision when only workflow, build or release-assurance controls change.
Such a revision does not change the installed app, the prayer corpus or `release.json`.
Use the package filename and its accompanying decision lock to identify the latest
repository bundle.
