import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookVerificationError } from './errors';
import type { WebhookEvent } from './types';

type RawPayload = string | Uint8Array;

function toBuffer(payload: RawPayload): Buffer {
  return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
}

/**
 * Vérifie la signature HMAC-SHA256 d'un webhook Fameen (`X-Fameen-Signature`).
 *
 * ⚠️ `payload` doit être le **corps brut** de la requête, avant tout parsing
 * JSON (un re-`JSON.stringify` ne produit pas forcément les mêmes octets).
 */
export function verifyWebhookSignature(payload: RawPayload, signature: string | undefined | null, secret: string): boolean {
  if (!secret) throw new TypeError('`secret` est requis (secret "whsec_…" du compte).');
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(toBuffer(payload)).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Vérifie la signature puis parse l'événement — à appeler dans votre handler
 * de webhook. Jette {@link WebhookVerificationError} si la signature ou le
 * corps est invalide : répondez alors 401 et ne traitez rien.
 *
 * ```ts
 * app.post('/webhooks/fameen', express.raw({ type: 'application/json' }), (req, res) => {
 *   const event = constructWebhookEvent(req.body, req.get('X-Fameen-Signature'), secret);
 *   // event.sid / event.status / event.event
 *   res.status(200).end();
 * });
 * ```
 */
export function constructWebhookEvent(
  payload: RawPayload,
  signature: string | undefined | null,
  secret: string,
): WebhookEvent {
  if (!verifyWebhookSignature(payload, signature, secret)) {
    throw new WebhookVerificationError('Signature X-Fameen-Signature invalide — événement rejeté.');
  }
  try {
    return JSON.parse(toBuffer(payload).toString('utf8')) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('Corps de webhook illisible (JSON invalide).');
  }
}
