# Mes prières — PWA privée personnalisable

## Version V0.1.6-help-audited

Cette version ajoute un contrôle de mise à jour explicite :

- la version installée est visible au bas de **Mes prières** et dans **Réglages** ;
- **Réglages → Mise à jour → Vérifier les mises à jour** compare la version installée à `release.json`, la version actuellement accessible sur le site publié ;
- lorsqu’une version plus récente est détectée, l’utilisateur choisit **Installer la mise à jour** ; l’application ne force jamais une mise à jour pendant une lecture ;
- `release.json` est volontairement vérifié sur le réseau et n’est pas précaché par le service worker ; sans connexion, l’application reste utilisable hors ligne mais ne peut pas vérifier la dernière version.

La version V0.1.6-help-audited ne modifie ni le corpus de prières ni ses identifiants. Elle ajoute uniquement le mécanisme de version/mise à jour et les contrôles associés.

## État et limites

- Prototype privé ; **non approuvé pour diffusion publique**.
- Le corpus demeure **À valider** quant aux textes, sources, attributions, provenance et droits.
- Le test E2E ne démarre pas de serveur et ne réalise pas l’installation PWA, l’enregistrement réel du service worker ni le rechargement hors ligne sur appareil.
- GitHub Pages peut être publiquement accessible : ne déclenchez pas le workflow Pages avant validation éditoriale et décision explicite de publication.

## Lancer les contrôles

```bash
npm run verify:ci
npm run pages:prepare
npm run pages:verify
npm run github:verify
```

Le dossier de travail peut porter n’importe quel nom. Les packages de release conservent la racine interne canonique `mes-prieres-pwa-prototype-v0.1.6-help-audited`.


### Révision du package GitHub

La version de l’application reste **V0.1.6-help-audited**. Une révision ultérieure du
**package GitHub** peut ne modifier que les workflows, les contrôles de build ou les audits
de livraison ; elle ne change alors ni le runtime installé, ni `release.json`, ni le corpus.
Avant de créer un ZIP de dépôt, utilisez `npm run github:package` : cette commande exécute
obligatoirement `npm run github:verify` avant la construction du package.

## Aide intégrée

L’**Aide intégrée** décrit les listes, le Répertoire, la lecture, les sauvegardes, le mode hors ligne, les limites connues et le mécanisme de mise à jour. Elle est incluse dans le bundle hors ligne.

## GitHub Pages

Consultez `docs/GITHUB_SETUP.md`. Le workflow de déploiement est manuel et requiert une confirmation explicite, car il peut exposer un site accessible publiquement.
