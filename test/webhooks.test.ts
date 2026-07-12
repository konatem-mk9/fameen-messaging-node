import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebhookVerificationError, constructWebhookEvent, verifyWebhookSignature } from '../src/index';

const SECRET = 'whsec_test_secret';

const EVENT = {
  event: 'delivered',
  sid: 'msg_1',
  status: 'delivered',
  channel: 'sms',
  to: '+224620000000',
  from: 'FAMEEN',
  error: null,
  externalId: 'op-1',
  timestamp: '2026-07-12T10:15:07.412Z',
};

function sign(payload: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

describe('webhooks', () => {
  it('valide une signature correcte (string et Buffer)', () => {
    const raw = JSON.stringify(EVENT);
    const sig = sign(raw);
    expect(verifyWebhookSignature(raw, sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(raw, 'utf8'), sig, SECRET)).toBe(true);
  });

  it('rejette une signature altérée, un mauvais secret ou une signature absente', () => {
    const raw = JSON.stringify(EVENT);
    const sig = sign(raw);
    expect(verifyWebhookSignature(raw + ' ', sig, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, sig.slice(0, -1) + '0', SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, sign(raw, 'whsec_autre'), SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(() => verifyWebhookSignature(raw, sig, '')).toThrow(TypeError);
  });

  it('constructWebhookEvent renvoie l’événement typé quand la signature est valide', () => {
    const raw = JSON.stringify(EVENT);
    const event = constructWebhookEvent(raw, sign(raw), SECRET);
    expect(event.sid).toBe('msg_1');
    expect(event.event).toBe('delivered');
  });

  it('constructWebhookEvent jette WebhookVerificationError sur signature ou JSON invalide', () => {
    const raw = JSON.stringify(EVENT);
    expect(() => constructWebhookEvent(raw, 'mauvaise-signature', SECRET)).toThrow(WebhookVerificationError);
    const notJson = 'pas du json';
    expect(() => constructWebhookEvent(notJson, sign(notJson), SECRET)).toThrow(WebhookVerificationError);
  });
});
