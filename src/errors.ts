import type { RateLimitInfo } from './types';

/** Codes d'erreur stables renvoyés par l'API (`error.code`). */
export type FameenErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'insufficient_credits'
  | 'channel_not_allowed'
  | 'not_found'
  | 'rate_limited'
  | 'internal_error'
  | 'unknown_error'
  | (string & {});

/** Classe mère de toutes les erreurs du SDK. */
export class FameenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Erreur renvoyée par l'API (réponse HTTP non-2xx).
 * `code` reprend `error.code` du corps (`unauthorized`, `insufficient_credits`,
 * `channel_not_allowed`, `rate_limited`, `not_found`, …).
 */
export class FameenApiError extends FameenError {
  /** Statut HTTP (401, 402, 403, 404, 429, 500…). */
  readonly status: number;
  readonly code: FameenErrorCode;
  /** Renseigné sur les 429 (et quand les en-têtes sont présents). */
  readonly rateLimit: RateLimitInfo | null;
  /** Secondes à attendre avant de réessayer (en-tête `Retry-After`), si fourni. */
  readonly retryAfter: number | null;

  constructor(params: {
    status: number;
    code: FameenErrorCode;
    message: string;
    rateLimit?: RateLimitInfo | null;
    retryAfter?: number | null;
  }) {
    super(params.message);
    this.status = params.status;
    this.code = params.code;
    this.rateLimit = params.rateLimit ?? null;
    this.retryAfter = params.retryAfter ?? null;
  }
}

/** Échec réseau : l'API n'a pas pu être jointe (DNS, timeout, coupure…). */
export class FameenConnectionError extends FameenError {}

/** Signature ou corps de webhook invalide — ne traitez pas l'événement. */
export class WebhookVerificationError extends FameenError {}
