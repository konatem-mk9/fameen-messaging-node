import { FameenApiError, FameenConnectionError, type FameenErrorCode } from './errors';
import { hasMedia, serializeSendBody } from './media';
import type {
  Attachment,
  Channel,
  CreateMessageParams,
  HistoryPage,
  HistoryParams,
  ListMessagesParams,
  MediaContent,
  MessageList,
  MessageResource,
  RateLimitInfo,
  RequestOptions,
  SendParams,
  WalletBalance,
} from './types';

const VERSION = '0.2.0';
const DEFAULT_BASE_URL = 'https://business.fameengroupe.com/api/v1';

export interface FameenMessagingOptions {
  /** Clé API du compte (`fam_…`) — jamais côté navigateur. */
  apiKey: string;
  /** Défaut : `https://business.fameengroupe.com/api/v1`. */
  baseUrl?: string;
  /** Timeout par tentative, en millisecondes (défaut : 30 000). */
  timeoutMs?: number;
  /**
   * Nombre de réessais automatiques (défaut : 2) sur erreur réseau, 429 et 5xx.
   * Un POST sans `idempotencyKey` n'est réessayé que sur 429 (jamais traité) ;
   * fournissez une clé d'idempotence pour rendre tous les réessais sûrs.
   */
  maxRetries?: number;
  /** Base du backoff exponentiel en ms (défaut : 500). Surtout utile en test. */
  retryBaseMs?: number;
  /** Implémentation `fetch` custom (tests, proxys). Défaut : `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

interface InternalRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

/**
 * Client de l'API Fameen Messaging.
 *
 * ```ts
 * const fameen = new FameenMessaging({ apiKey: process.env.FAMEEN_API_KEY! });
 * const msg = await fameen.sms.send({ to: '+224620000000', message: 'Bonjour !' });
 * ```
 */
export class FameenMessaging {
  readonly messages: MessagesResource;
  readonly sms: SmsResource;
  readonly whatsapp: WhatsappResource;
  readonly email: EmailResource;
  readonly wallet: WalletResource;

  /** Compteurs `X-RateLimit-*` de la dernière réponse qui les fournissait. */
  lastRateLimit: RateLimitInfo | null = null;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: FameenMessagingOptions) {
    if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
      throw new TypeError('FameenMessaging: `apiKey` est requis (clé "fam_…").');
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 500);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchFn !== 'function') {
      throw new TypeError('FameenMessaging: `fetch` indisponible — Node 18+ requis (ou passez options.fetch).');
    }

    this.messages = new MessagesResource(this);
    this.sms = new SmsResource(this);
    this.whatsapp = new WhatsappResource(this);
    this.email = new EmailResource(this);
    this.wallet = new WalletResource(this);
  }

  /** @internal */
  async request<T>(method: 'GET' | 'POST', path: string, opts: InternalRequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `fameen-messaging-node/${VERSION}`,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let lastConnectionError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url.toString(), {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'follow',
        });
      } catch (err) {
        // Échec réseau : la requête n'a (très probablement) pas été traitée.
        lastConnectionError = err;
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new FameenConnectionError(
          `Impossible de joindre l'API Fameen (${url.hostname}) : ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      const rateLimit = this.readRateLimit(res);
      if (rateLimit) this.lastRateLimit = rateLimit;

      const raw = await res.text();
      let parsed: unknown = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
      }

      if (res.ok) {
        const body = parsed as { success?: boolean; data?: unknown } | null;
        // Enveloppe standard { success, data } → on renvoie `data` directement.
        if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
          return body.data as T;
        }
        return parsed as T;
      }

      const errBody = parsed as { error?: { code?: string; message?: string }; message?: string } | null;
      const code: FameenErrorCode = errBody?.error?.code ?? this.codeFromStatus(res.status);
      const message =
        errBody?.error?.message ??
        errBody?.message ??
        `Erreur HTTP ${res.status} sur ${method} ${url.pathname}`;
      const retryAfter = this.readRetryAfter(res);

      const retriable = res.status === 429 || res.status >= 500;
      // POST non idempotent : un 5xx a pu être traité côté serveur → pas de réessai.
      const safeToRetry = method === 'GET' || Boolean(opts.idempotencyKey) || res.status === 429;

      if (retriable && safeToRetry && attempt < this.maxRetries) {
        await this.sleep(retryAfter !== null ? retryAfter * 1000 : this.backoffMs(attempt));
        continue;
      }

      throw new FameenApiError({ status: res.status, code, message, rateLimit: this.lastRateLimit, retryAfter });
    }

    // Inatteignable (la boucle jette toujours), mais TypeScript l'exige.
    throw new FameenConnectionError('Réessais épuisés.', { cause: lastConnectionError });
  }

  private codeFromStatus(status: number): FameenErrorCode {
    switch (status) {
      case 400: return 'bad_request';
      case 401: return 'unauthorized';
      case 402: return 'insufficient_credits';
      case 403: return 'channel_not_allowed';
      case 404: return 'not_found';
      case 429: return 'rate_limited';
      default: return status >= 500 ? 'internal_error' : 'unknown_error';
    }
  }

  private readRateLimit(res: Response): RateLimitInfo | null {
    const limit = Number(res.headers.get('X-RateLimit-Limit'));
    const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
    const reset = Number(res.headers.get('X-RateLimit-Reset'));
    if (Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(reset) && limit > 0) {
      return { limit, remaining, reset };
    }
    return null;
  }

  private readRetryAfter(res: Response): number | null {
    const v = Number(res.headers.get('Retry-After'));
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  private backoffMs(attempt: number): number {
    const base = this.retryBaseMs * 2 ** attempt;
    return base + Math.floor(Math.random() * this.retryBaseMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Valide les champs minimum avant d'appeler l'API (meilleure DX). */
function assertSendable(
  params: { to?: string; message?: string; media?: MediaContent; attachments?: Attachment[] },
  channel?: Channel,
): void {
  if (!params || typeof params.to !== 'string' || !params.to.trim()) {
    throw new TypeError('`to` est requis (numéro E.164 ou adresse email).');
  }
  const withMedia = hasMedia(params);
  // Un message peut n'être qu'un média (légende facultative).
  if (!withMedia && (typeof params.message !== 'string' || !params.message.trim())) {
    throw new TypeError('`message` est requis (ou fournissez un média).');
  }
  if (withMedia && channel === 'sms') {
    throw new TypeError('Le canal SMS ne supporte pas les pièces jointes.');
  }
  if (channel && channel !== 'email' && params.to.includes('@')) {
    throw new TypeError(`\`to\` ressemble à un email mais le canal demandé est "${channel}".`);
  }
}

/** Ressource « Messages » unifiée (façon Twilio). */
export class MessagesResource {
  constructor(private readonly client: FameenMessaging) {}

  /** Envoie un message — canal explicite ou déduit du destinataire. */
  create(params: CreateMessageParams, options: RequestOptions = {}): Promise<MessageResource> {
    assertSendable(params, params.channel);
    return this.client.request<MessageResource>('POST', '/messages', {
      body: serializeSendBody(params),
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Statut courant d'un message. */
  get(sid: string): Promise<MessageResource> {
    if (!sid || !sid.trim()) throw new TypeError('`sid` est requis.');
    return this.client.request<MessageResource>('GET', `/messages/${encodeURIComponent(sid.trim())}`);
  }

  /** Liste paginée (filtres canal / statut / destinataire). */
  list(params: ListMessagesParams = {}): Promise<MessageList> {
    return this.client.request<MessageList>('GET', '/messages', {
      query: {
        channel: params.channel,
        status: params.status,
        to: params.to,
        page: params.page,
        limit: params.limit,
      },
    });
  }

  /** @deprecated Endpoint historique aux lignes brutes — préférez {@link list}. */
  history(params: HistoryParams = {}): Promise<HistoryPage> {
    return this.client.request<HistoryPage>('GET', '/messages/history', {
      query: { channel: params.channel, status: params.status, page: params.page },
    });
  }
}

abstract class ChannelResource {
  protected abstract readonly path: string;
  protected abstract readonly channel: Channel;
  constructor(protected readonly client: FameenMessaging) {}

  /** Envoie un message sur ce canal (nécessite le scope correspondant). */
  send(params: SendParams, options: RequestOptions = {}): Promise<MessageResource> {
    assertSendable(params, this.channel);
    return this.client.request<MessageResource>('POST', this.path, {
      body: serializeSendBody(params),
      idempotencyKey: options.idempotencyKey,
    });
  }
}

export class SmsResource extends ChannelResource {
  protected override readonly path = '/sms/send';
  protected override readonly channel = 'sms' as const;
}

export class WhatsappResource extends ChannelResource {
  protected override readonly path = '/whatsapp/send';
  protected override readonly channel = 'whatsapp' as const;
}

export class EmailResource extends ChannelResource {
  protected override readonly path = '/email/send';
  protected override readonly channel = 'email' as const;
}

export class WalletResource {
  constructor(private readonly client: FameenMessaging) {}

  /** Soldes SMS / WhatsApp / Email et mode de facturation. */
  balance(): Promise<WalletBalance> {
    return this.client.request<WalletBalance>('GET', '/wallet/balance');
  }
}
