import { describe, expect, it, vi } from 'vitest';
import { FameenApiError, FameenConnectionError, FameenMessaging } from '../src/index';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function makeClient(fetchMock: FetchMock, overrides: Partial<ConstructorParameters<typeof FameenMessaging>[0]> = {}) {
  return new FameenMessaging({
    apiKey: 'fam_test_key',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    retryBaseMs: 1,
    ...overrides,
  });
}

const MESSAGE = {
  sid: 'msg_1',
  status: 'queued',
  channel: 'sms',
  to: '+224620000000',
  from: 'FAMEEN',
  body: 'Bonjour',
  segments: 1,
  credits: 1,
  error: null,
  externalId: null,
  statusCallback: null,
  createdAt: '2026-07-12T10:00:00.000Z',
  sentAt: null,
  deliveredAt: null,
};

describe('FameenMessaging', () => {
  it('exige une apiKey', () => {
    expect(() => new FameenMessaging({ apiKey: '' })).toThrow(TypeError);
  });

  it('envoie un message unifié : bon endpoint, auth, idempotence, unwrap de l’enveloppe', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: MESSAGE, message: 'OK' }));
    const client = makeClient(fetchMock);

    const msg = await client.messages.create(
      { to: '+224620000000', message: 'Bonjour', channel: 'sms' },
      { idempotencyKey: 'order-1' },
    );

    expect(msg).toEqual(MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://business.fameengroupe.com/api/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer fam_test_key');
    expect(init.headers['Idempotency-Key']).toBe('order-1');
    expect(JSON.parse(init.body)).toEqual({ to: '+224620000000', message: 'Bonjour', channel: 'sms' });
  });

  it('expose les raccourcis par canal (sms/whatsapp/email)', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ success: true, data: MESSAGE })));
    const client = makeClient(fetchMock);

    await client.sms.send({ to: '+224620000000', message: 'a' });
    await client.whatsapp.send({ to: '+224620000000', message: 'b' });
    await client.email.send({ to: 'x@y.com', subject: 's', message: 'c' });

    const paths = fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(paths).toEqual(['/api/v1/sms/send', '/api/v1/whatsapp/send', '/api/v1/email/send']);
  });

  it('refuse localement un envoi sans destinataire ni message', async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock);
    await expect(async () => client.sms.send({ to: '', message: 'x' })).rejects.toThrow(TypeError);
    await expect(async () => client.sms.send({ to: '+224', message: '  ' })).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('construit la query string de list()', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { data: [MESSAGE], page: 2, limit: 10, total: 11, totalPages: 2 } }));
    const client = makeClient(fetchMock);

    const page = await client.messages.list({ channel: 'sms', status: 'failed', page: 2, limit: 10 });

    expect(page.totalPages).toBe(2);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/messages');
    expect(url.searchParams.get('channel')).toBe('sms');
    expect(url.searchParams.get('status')).toBe('failed');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('mappe une erreur API en FameenApiError (code + statut + message)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'insufficient_credits', message: 'Crédits insuffisants pour ce canal' }, statusCode: 402 },
        { status: 402 },
      ),
    );
    const client = makeClient(fetchMock, { maxRetries: 0 });

    const err = await client.sms.send({ to: '+224620000000', message: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(FameenApiError);
    expect(err.status).toBe(402);
    expect(err.code).toBe('insufficient_credits');
    expect(err.message).toContain('Crédits insuffisants');
  });

  it('réessaie sur 429 en respectant Retry-After, puis réussit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: { code: 'rate_limited', message: 'Trop de requêtes' }, statusCode: 429 },
          { status: 429, headers: { 'Retry-After': '0', 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1752316500' } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: MESSAGE }));
    const client = makeClient(fetchMock, { maxRetries: 2 });

    const msg = await client.sms.send({ to: '+224620000000', message: 'x' });
    expect(msg.sid).toBe('msg_1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.lastRateLimit).toEqual({ limit: 60, remaining: 0, reset: 1752316500 });
  });

  it('ne réessaie PAS un POST 500 sans clé d’idempotence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'internal_error', message: 'Erreur interne' }, statusCode: 500 }, { status: 500 }),
    );
    const client = makeClient(fetchMock, { maxRetries: 3 });

    await expect(client.sms.send({ to: '+224620000000', message: 'x' })).rejects.toBeInstanceOf(FameenApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('réessaie un POST 500 AVEC clé d’idempotence', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: false, error: { code: 'internal_error', message: 'Erreur interne' }, statusCode: 500 }, { status: 500 }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: MESSAGE }));
    const client = makeClient(fetchMock, { maxRetries: 2 });

    const msg = await client.messages.create({ to: '+224620000000', message: 'x' }, { idempotencyKey: 'k-1' });
    expect(msg.sid).toBe('msg_1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('convertit un échec réseau persistant en FameenConnectionError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = makeClient(fetchMock, { maxRetries: 1 });

    await expect(client.wallet.balance()).rejects.toBeInstanceOf(FameenConnectionError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 tentative + 1 réessai
  });

  it('récupère le solde du portefeuille', async () => {
    const balance = {
      smsCredits: 120,
      waCredits: 40,
      emailCredits: 990,
      billing: { mode: 'prepaid', postpaid: false, prepaidRequired: true, sendingBlocked: false },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: balance }));
    const client = makeClient(fetchMock);

    await expect(client.wallet.balance()).resolves.toEqual(balance);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe('/api/v1/wallet/balance');
  });
});
