# Statut du corpus — Prototype V0.1.6-help-audited

## Source de travail

Les sept textes ont été importés depuis le document utilisateur `Repertoire de prieres.docx` fourni le 30 juin 2026.

## Règle de ce prototype

- Les textes sont fournis uniquement pour tester l’expérience de lecture, la recherche et la personnalisation.
- Ils ne constituent pas encore un corpus éditorial publiable.
- Aucune correction doctrinale, liturgique, biblique ou de provenance n’est réputée avoir été effectuée.
- Cette build ne revendique pas une fidélité caractère par caractère au document de travail : des variantes de titre, d’orthographe, de ponctuation ou de formulation peuvent subsister.
- Les titres, majuscules, orthographe, ponctuation et formulations doivent être comparés à des sources de référence avant toute distribution publique.

## Éléments non importés

Le document mentionne le Notre Père et le Je vous salue Marie mais ne donne pas leur texte intégral. Ils ne sont donc pas ajoutés au Répertoire dans cette build.

## Source de vérité technique

`data/prayers.json` est le corpus canonique. Ne pas modifier `data/prayers.js` à la main : exécuter `python3 tools/generate_corpus_js.py` après chaque modification du JSON. Utiliser `python3 tools/generate_corpus_js.py --check` pendant les audits : ce mode ne modifie aucun fichier et échoue si le bundle est périmé.

L’aide intégrée est un contenu distinct : `data/help.json` est l’aide canonique et `data/help.js` est son bundle navigateur généré par `python3 tools/generate_help_js.py`. Elle ne modifie ni la version ni le statut éditorial du corpus. Son mode `--check` a la même règle non destructive.

La V0.1.6-help-audited conserve le corpus inchangé ; elle ne contient que des corrections techniques de release-assurance.

## V0.1.6 update feature boundary

V0.1.6 does not alter `data/prayers.json`, prayer identifiers, blocks, categories, source status or corpus version. It adds only the app-level version and manual-update mechanism. `release.json` is technical publication metadata, not editorial evidence for the corpus.
