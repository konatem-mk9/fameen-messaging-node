# fameen-messaging

SDK Node.js officiel de l'**API Fameen Messaging** — envoyez des SMS, des messages WhatsApp et des emails transactionnels depuis votre application, avec suivi de statut par webhooks signés.

- **Zéro dépendance** (fetch natif) · TypeScript first · ESM + CommonJS
- Réessais automatiques intelligents (réseau, 429 avec `Retry-After`, 5xx idempotents)
- Idempotence intégrée (`Idempotency-Key`)
- Vérification de signature des webhooks (HMAC-SHA256, comparaison en temps constant)

> Node.js ≥ 18. Documentation complète de l'API : `https://fameenbusiness.com/api/docs`.

## Installation

```bash
npm install fameen-messaging
```

## Démarrage rapide

Créez votre clé API dans le tableau de bord Communication (Paramètres → Clés API), puis :

```ts
import { FameenMessaging } from 'fameen-messaging';

const fameen = new FameenMessaging({ apiKey: process.env.FAMEEN_API_KEY! });

const msg = await fameen.sms.send({
  to: '+224620000000',
  message: 'Votre code de vérification est 1234',
});

console.log(msg.sid, msg.status); // "cmcx1k2…" "queued"
```

L'envoi est **asynchrone** : la réponse est `queued`, le statut final (`sent`, `delivered`, `failed`) arrive par webhook ou par lecture :

```ts
const current = await fameen.messages.get(msg.sid);
```

## Envoi

```ts
// Endpoint unifié — canal explicite ou déduit du destinataire (@ → email, sinon sms)
await fameen.messages.create(
  {
    channel: 'whatsapp',                          // 'sms' | 'whatsapp' | 'email'
    to: '+224620000000',
    message: 'Bonjour {prenom}, votre commande est prête.',
    statusCallback: 'https://monapp.com/webhooks/fameen',
  },
  { idempotencyKey: 'order-4812-notif' },         // anti-doublon 24 h, fortement recommandé
);

// Raccourcis par canal
await fameen.sms.send({ to: '+224620000000', message: '…' });
await fameen.whatsapp.send({ to: '+224620000000', message: '…' });
await fameen.email.send({ to: 'client@example.com', subject: 'Confirmation', message: '…' });
```

## Médias (pièces jointes)

WhatsApp et email acceptent des pièces jointes (PDF, images, vidéo, audio). Passez un `Buffer`/`Uint8Array` (ou un base64) — le SDK l'encode ; l'API héberge le fichier et le distribue. **SMS non supporté.** Quand un média est fourni, `message` peut être vide.

```ts
import { FameenMessaging, fileAttachment } from 'fameen-messaging';
import { readFileSync } from 'node:fs';

const fameen = new FameenMessaging({ apiKey: process.env.FAMEEN_API_KEY! });

// WhatsApp : un seul média par message, message = légende (facultative)
await fameen.whatsapp.send({
  to: '+224620000000',
  message: 'Votre facture',
  media: readFileSync('facture.pdf'),
  fileName: 'facture.pdf',
});

// Email : plusieurs pièces jointes
await fameen.email.send({
  to: 'client@exemple.com',
  subject: 'Vos documents',
  message: 'Bonjour, voir en pièces jointes.',
  attachments: [await fileAttachment('facture.pdf'), await fileAttachment('cgv.pdf')],
});
```

Chaque pièce jointe : `{ content, filename?, contentType?, type? }` où `content` est un `Buffer`/`Uint8Array`/base64 et `type` vaut `image | video | audio | document` (déduit du type MIME si absent). Max 16 Mo par fichier.

## Codes de vérification (OTP)

Authentifiez un utilisateur par code à usage unique sur **SMS, WhatsApp ou email**.
Le code est généré, stocké haché et vérifié **côté serveur** : il ne transite jamais
par votre application et n'apparaît dans aucune réponse. Vous n'avez ni génération,
ni stockage, ni expiration à gérer.

```ts
// 1. Envoyer le code (canal déduit du destinataire si absent)
const v = await fameen.otp.send({ to: '+224620000000', channel: 'sms' });
// → { verificationId: 'ver_…', status: 'pending', expiresAt: '…', attemptsRemaining: 5 }

// 2. Contrôler le code saisi par l'utilisateur
const r = await fameen.otp.verify({ verificationId: v.verificationId, code: '483920' });
if (r.status === 'approved') {
  // utilisateur authentifié
} else {
  // r.reason : 'invalid_code' | 'expired' | 'max_attempts'
  console.log(`Échec (${r.reason}), ${r.attemptsRemaining} tentative(s) restante(s)`);
}
```

Un code erroné **ne lève pas d'erreur** : la réponse porte `status: 'rejected'` et
`reason`. Seules les erreurs de transport ou d'authentification lèvent.

Si vous ne conservez pas le `verificationId`, vérifiez par destinataire — la
vérification en cours la plus récente est utilisée :

```ts
await fameen.otp.verify({ to: '+224620000000', code: '483920' });
```

Options d'envoi : `codeLength` (4–8), `ttlSeconds` (60–3600), `maxAttempts` (1–10),
`template` (doit contenir `{{code}}` ; marqueurs `{{code}}`, `{{minutes}}`,
`{{seconds}}`, `{{company}}`), `subject` (email) et `statusCallback`. Sans ces
paramètres, les réglages du compte s'appliquent (portail → Réglages → Codes OTP).

À savoir :

- L'envoi exige **le scope du canal** utilisé et consomme un crédit de ce canal.
- Un code validé est **à usage unique** ; le revérifier renvoie `rejected`.
- Demander un nouveau code pour le même destinataire **annule le précédent**.
- `fameen.otp.get(verificationId)` retourne l'état courant, jamais le code.
- `otp.send` accepte une clé d'idempotence : `{ idempotencyKey: 'otp-001' }`.

## Lecture & solde

```ts
// Liste paginée (filtres channel / status / to, limit ≤ 100)
const page = await fameen.messages.list({ channel: 'sms', status: 'failed', page: 1, limit: 30 });
console.log(page.total, page.data[0]?.sid);

// Solde et mode de facturation
const balance = await fameen.wallet.balance();
if (!balance.billing.postpaid && balance.smsCredits < 100) {
  console.warn('Crédits SMS bientôt épuisés');
}
```

## Webhooks de statut

À chaque changement de statut (`queued`, `sent`, `delivered`, `failed`), la plateforme POSTe un événement signé sur votre URL. Vérifiez **toujours** la signature sur le **corps brut** :

```ts
import express from 'express';
import { constructWebhookEvent, WebhookVerificationError } from 'fameen-messaging';

const app = express();

app.post('/webhooks/fameen', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(
      req.body,                                   // Buffer brut — PAS req.body parsé en JSON
      req.get('X-Fameen-Signature'),
      process.env.FAMEEN_WEBHOOK_SECRET!,         // secret "whsec_…" (Paramètres → Webhooks)
    );
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.status(401).end();
    throw err;
  }

  // Traitez de façon idempotente : le couple (sid, event) peut arriver deux fois.
  console.log(event.sid, event.event, event.status);
  res.status(200).end();                          // répondez 2xx vite, traitez en tâche de fond
});
```

Livraison : 5 réessais avec backoff sur non-2xx, timeout 10 s, HTTPS public obligatoire.

## Gestion des erreurs

```ts
import { FameenApiError, FameenConnectionError } from 'fameen-messaging';

try {
  await fameen.sms.send({ to: '+224620000000', message: '…' });
} catch (err) {
  if (err instanceof FameenApiError) {
    // err.status : 400 | 401 | 402 | 403 | 404 | 429 | 500
    // err.code   : 'insufficient_credits', 'channel_not_allowed', 'rate_limited', …
    if (err.code === 'insufficient_credits') {
      // rediriger vers la recharge de crédits
    }
    if (err.code === 'rate_limited') {
      console.log('Réessayer dans', err.retryAfter, 's', err.rateLimit);
    }
  } else if (err instanceof FameenConnectionError) {
    // réseau injoignable après réessais
  }
}
```

## Réessais & idempotence

| Situation | Comportement par défaut |
|---|---|
| Erreur réseau | réessayé (jusqu'à `maxRetries`, backoff exponentiel) |
| `429 rate_limited` | réessayé en respectant `Retry-After` |
| `5xx` sur GET | réessayé |
| `5xx` sur POST **avec** `idempotencyKey` | réessayé (sans risque de doublon) |
| `5xx` sur POST **sans** `idempotencyKey` | **non réessayé** (le serveur a pu traiter l'envoi) |

Fournissez systématiquement une `idempotencyKey` métier (ID de commande, de notification…) sur vos envois.

## Configuration

```ts
new FameenMessaging({
  apiKey: 'fam_…',                                        // requis
  baseUrl: 'https://fameenbusiness.com/api/v1',    // défaut
  timeoutMs: 30_000,                                      // timeout par tentative
  maxRetries: 2,                                          // réessais automatiques
  fetch: customFetch,                                     // injection (tests, proxy)
});
```

`client.lastRateLimit` expose les compteurs `X-RateLimit-*` de la dernière réponse (limite : 60 requêtes/min par clé).

## Sécurité

- La clé `fam_…` est un **secret serveur** : jamais dans un navigateur, une app mobile ou un dépôt git.
- Créez une clé par application/environnement, avec les seuls scopes nécessaires (`sms`, `whatsapp`, `email`).
- Régénérez le secret webhook (`whsec_…`) en cas de doute — l'ancien est invalidé immédiatement.

## Développement

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/ (ESM + CJS + .d.ts)
```

## Licence

MIT © Fameen Groupe
