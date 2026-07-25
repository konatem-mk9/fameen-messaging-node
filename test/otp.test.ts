import { describe, expect, it, vi } from 'vitest';
import { FameenMessaging } from '../src/index';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchMock: FetchMock) {
  return new FameenMessaging({
    apiKey: 'fam_test_key',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    retryBaseMs: 1,
  });
}

const PENDING = {
  verificationId: 'ver_1',
  status: 'pending',
  channel: 'sms',
  to: '+224620000000',
  attempts: 0,
  maxAttempts: 5,
  attemptsRemaining: 5,
  expiresAt: '2026-07-25T23:05:00.000Z',
  createdAt: '2026-07-25T23:00:00.000Z',
  messageSid: 'msg_1',
};

/** Corps JSON envoyé lors du dernier appel fetch simulé. */
const lastBody = (fetchMock: FetchMock) => JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
const lastUrl = (fetchMock: FetchMock) => String(fetchMock.mock.calls.at(-1)![0]);

describe('otp.send', () => {
  it('poste sur /otp/send et retourne la verification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: PENDING }));
    const res = await makeClient(fetchMock).otp.send({ to: '+224620000000', channel: 'sms' });

    expect(lastUrl(fetchMock)).toContain('/otp/send');
    expect(lastBody(fetchMock)).toMatchObject({ to: '+224620000000', channel: 'sms' });
    expect(res.verificationId).toBe('ver_1');
    expect(res.status).toBe('pending');
  });

  it('transmet les reglages ponctuels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: PENDING }));
    await makeClient(fetchMock).otp.send({
      to: 'client@exemple.com',
      codeLength: 8,
      ttlSeconds: 600,
      maxAttempts: 3,
      subject: 'Votre code',
    });

    expect(lastBody(fetchMock)).toMatchObject({
      to: 'client@exemple.com', codeLength: 8, ttlSeconds: 600, maxAttempts: 3, subject: 'Votre code',
    });
  });

  it('accepte une cle d idempotence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: PENDING }));
    await makeClient(fetchMock).otp.send({ to: '+224620000000' }, { idempotencyKey: 'otp-001' });

    const headers = fetchMock.mock.calls.at(-1)![1].headers;
    expect(headers['Idempotency-Key']).toBe('otp-001');
  });

  it('refuse un destinataire vide', async () => {
    const client = makeClient(vi.fn());
    await expect(async () => client.otp.send({ to: '  ' })).rejects.toThrow(TypeError);
  });

  it('refuse un gabarit sans marqueur de code', async () => {
    const client = makeClient(vi.fn());
    await expect(async () => client.otp.send({ to: '+224620000000', template: 'Bonjour !' })).rejects.toThrow(TypeError);
  });

  it('refuse un email avec un canal non-email', async () => {
    const client = makeClient(vi.fn());
    await expect(async () => client.otp.send({ to: 'a@b.c', channel: 'sms' })).rejects.toThrow(TypeError);
  });
});

describe('otp.verify', () => {
  it('valide un code correct', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { ...PENDING, status: 'approved', attempts: 1, attemptsRemaining: 4 } }),
    );
    const res = await makeClient(fetchMock).otp.verify({ verificationId: 'ver_1', code: '483920' });

    expect(lastUrl(fetchMock)).toContain('/otp/verify');
    expect(lastBody(fetchMock)).toMatchObject({ verificationId: 'ver_1', code: '483920' });
    expect(res.status).toBe('approved');
  });

  it('ne leve pas d erreur sur un code errone : status rejected + reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { ...PENDING, status: 'rejected', reason: 'invalid_code', attempts: 1, attemptsRemaining: 4 } }),
    );
    const res = await makeClient(fetchMock).otp.verify({ verificationId: 'ver_1', code: '000000' });

    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('invalid_code');
    expect(res.attemptsRemaining).toBe(4);
  });

  it('accepte la verification par destinataire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ...PENDING, status: 'approved' } }));
    await makeClient(fetchMock).otp.verify({ to: '+224620000000', code: '483920' });

    expect(lastBody(fetchMock)).toMatchObject({ to: '+224620000000', code: '483920' });
  });

  it('exige un code', async () => {
    const client = makeClient(vi.fn());
    await expect(async () => client.otp.verify({ verificationId: 'ver_1', code: '' })).rejects.toThrow(TypeError);
  });

  it('exige verificationId ou to', async () => {
    const client = makeClient(vi.fn());
    await expect(async () => client.otp.verify({ code: '483920' })).rejects.toThrow(TypeError);
  });
});

describe('otp.get', () => {
  it('interroge /otp/{id} en encodant l identifiant', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: PENDING }));
    await makeClient(fetchMock).otp.get('ver/1');

    expect(lastUrl(fetchMock)).toContain('/otp/ver%2F1');
  });

  it('exige un identifiant', async () => {
    const client = makeClient(vi.fn());
    await expect(async () => client.otp.get('')).rejects.toThrow(TypeError);
  });
});
