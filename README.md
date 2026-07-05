# Café_digit — Backend & déploiement (Supabase + Netlify)

Ce dossier contient le backend réel de la plateforme, prêt à être déployé.

## Contenu

```
schema.sql                          → à exécuter dans Supabase (tables, RLS, données de départ)
supabase/functions/redeem-key/      → Edge Function publique : clé + email → session réelle
supabase/functions/generate-key/    → Edge Function admin : crée une nouvelle clé (après sélection/paiement)
index.html                          → frontend branché sur Supabase (à déployer sur Netlify)
netlify.toml                        → config Netlify
.env.example                        → variables à configurer
```

## Comment ça marche (vue d'ensemble)

1. Un candidat est sélectionné ou paie → vous (ou un futur automatisme) appelez `generate-key` → une clé `CD-XXXX-XXXX` est créée dans `access_keys` et envoyée par email.
2. Le candidat entre son email + sa clé sur le site → le frontend appelle `redeem-key`.
3. `redeem-key` vérifie la clé, crée un vrai utilisateur Supabase Auth si besoin, et renvoie une **vraie session** (access_token/refresh_token) — sans mot de passe ni lien à cliquer.
4. Le frontend stocke cette session (gérée automatiquement par `supabase-js`) et charge le parcours, filtré selon le `tier` (standard/premium) grâce aux règles de sécurité (RLS) de la base de données.
5. La progression de chaque leçon est enregistrée dans la table `progress`, propre à chaque utilisateur.

## Étape 1 — Créer le projet Supabase

1. Allez sur [supabase.com](https://supabase.com) → **New project**.
2. Une fois créé, ouvrez **SQL Editor** → collez le contenu de `schema.sql` → **Run**.
3. Allez dans **Project Settings > API** et notez :
   - `Project URL` → `SUPABASE_URL`
   - `anon public key` → `SUPABASE_ANON_KEY`
   - `service_role key` → `SUPABASE_SERVICE_ROLE_KEY` (⚠️ secret, ne jamais l'exposer côté client)

## Étape 2 — Déployer les Edge Functions

Installez la CLI Supabase puis, depuis ce dossier :

```bash
npm install -g supabase
supabase login
supabase link --project-ref VOTRE_REF_PROJET

# Configurer les secrets utilisés par les fonctions
cp .env.example .env
# → éditez .env avec vos vraies valeurs, puis :
supabase secrets set --env-file .env

# Déployer les deux fonctions
supabase functions deploy redeem-key --no-verify-jwt
supabase functions deploy generate-key --no-verify-jwt
```

`--no-verify-jwt` est nécessaire car ces fonctions doivent être appelables sans qu'un utilisateur soit déjà connecté (c'est justement leur rôle).

## Étape 3 — Générer votre première clé de test

```bash
curl -X POST https://VOTRE-PROJET.supabase.co/functions/v1/generate-key \
  -H "x-admin-secret: VOTRE_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"vous@exemple.com","tier":"premium"}'
```

La réponse contient `key_code` (ex. `CD-4F7K-9XQ2`) : c'est la clé à utiliser pour vous connecter.

## Étape 4 — Configurer et déployer le frontend sur Netlify

1. Ouvrez `index.html`, remplacez :
   ```js
   const SUPABASE_URL = "https://VOTRE-PROJET.supabase.co";
   const SUPABASE_ANON_KEY = "VOTRE_ANON_KEY";
   ```
   par vos vraies valeurs (l'anon key est publique par conception, elle peut être exposée côté client).
2. Déployez sur Netlify :
   - Via l'interface : glissez-déposez ce dossier sur [app.netlify.com/drop](https://app.netlify.com/drop), **ou**
   - Via CLI :
     ```bash
     npm install -g netlify-cli
     netlify deploy --prod
     ```
3. Testez : ouvrez l'URL Netlify, entrez l'email et la clé générées à l'étape 3.

## Étape 5 — Envoi automatique des clés par email (optionnel)

Créez un compte sur [resend.com](https://resend.com), vérifiez votre domaine d'envoi, récupérez une clé API et ajoutez-la à `.env` (`RESEND_API_KEY`) avant de relancer `supabase secrets set`. `generate-key` enverra alors l'email automatiquement.

## Prochaine étape naturelle : automatiser la génération de clé après paiement

Pour l'instant, `generate-key` s'appelle manuellement (ou via un script). Pour un vrai flux de paiement mobile money (Orange Money / MTN MoMo), l'étape suivante consiste à brancher leur webhook de confirmation de paiement sur un appel automatique à `generate-key` — je peux vous aider à la construire dès que vous aurez choisi votre agrégateur de paiement.

## Sécurité — points à retenir

- La `service_role key` ne doit **jamais** apparaître dans `index.html` ni dans un dépôt Git public : elle reste uniquement dans les secrets Supabase, utilisée par les Edge Functions.
- `ADMIN_SECRET` protège `generate-key` : changez la valeur par défaut avant tout déploiement réel.
- Les tables `courses`, `modules`, `lessons` sont en lecture seule pour les utilisateurs connectés ; seule votre équipe (via SQL Editor ou un futur back-office) doit pouvoir les modifier.
