/** Canaux d'envoi supportés par l'API. */
export type Channel = 'sms' | 'whatsapp' | 'email';

/** Cycle de vie d'un message : queued → sending → sent → delivered | failed. */
export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'failed';

/** Événements poussés sur votre webhook de statut (`X-Fameen-Event`). */
export type WebhookEventType = 'queued' | 'sent' | 'delivered' | 'failed';

/**
 * Ressource Message telle que renvoyée par l'API (`data` de l'enveloppe).
 * Les dates sont des chaînes ISO 8601.
 */
export interface MessageResource {
  /** Identifiant unique du message — à conserver pour le suivi. */
  sid: string;
  status: MessageStatus | string;
  channel: Channel | string;
  to: string;
  /** Expéditeur effectif (sender name SMS, numéro WhatsApp, adresse email). */
  from: string | null;
  body: string;
  /** Tranches de 160 caractères (SMS) ; 1 pour WhatsApp/email. */
  segments: number;
  credits: number;
  error: string | null;
  /** Identifiant du message chez l'opérateur, une fois envoyé. */
  externalId: string | null;
  statusCallback: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

/** Page renvoyée par `GET /v1/messages`. */
export interface MessageList {
  data: MessageResource[];
  page: number;
  /** Taille de page effective (max 100). */
  limit: number;
  total: number;
  totalPages: number;
}

/** Soldes et mode de facturation (`GET /v1/wallet/balance`). */
export interface WalletBalance {
  smsCredits: number;
  waCredits: number;
  emailCredits: number;
  billing: {
    mode: 'prepaid' | 'consumption';
    /** `true` = facturation à la consommation : l'envoi n'est pas limité par le solde. */
    postpaid: boolean;
    prepaidRequired: boolean;
    /** `true` = compte bloqué (période de consommation expirée). */
    sendingBlocked: boolean;
  };
}

/** Corps JSON reçu sur votre webhook de statut. */
export interface WebhookEvent {
  event: WebhookEventType | string;
  sid: string;
  status: MessageStatus | string;
  channel: Channel | string;
  to: string;
  from: string | null;
  error: string | null;
  externalId: string | null;
  /** ISO 8601 — date d'émission du callback. */
  timestamp: string;
}

/** Paramètres de l'envoi unifié (`POST /v1/messages`). */
export interface CreateMessageParams {
  /** Numéro E.164 (`+224…`) pour SMS/WhatsApp, adresse email pour le canal email. */
  to: string;
  /**
   * Contenu (max 5 000 caractères).
   * Variables de personnalisation : `{prenom}`, `{nom}`, `{email}`, `{phone}`.
   */
  message: string;
  /**
   * Canal explicite. Absent : email si `to` contient « @ », sinon sms.
   * WhatsApp doit donc toujours être explicite.
   */
  channel?: Channel;
  /** Objet de l'email (canal email uniquement, max 255). */
  subject?: string;
  /** URL HTTPS publique notifiée à chaque changement de statut. */
  statusCallback?: string;
}

/** Paramètres d'un envoi par canal dédié (`POST /v1/{sms|whatsapp|email}/send`). */
export type SendParams = Omit<CreateMessageParams, 'channel'>;

/** Options par requête. */
export interface RequestOptions {
  /**
   * Clé d'idempotence (en-tête `Idempotency-Key`) : tout réessai dans les 24 h
   * renvoie la réponse d'origine au lieu de créer un doublon. Elle rend aussi
   * les réessais automatiques du SDK sûrs sur les POST.
   */
  idempotencyKey?: string;
}

/** Filtres de `GET /v1/messages`. */
export interface ListMessagesParams {
  channel?: Channel;
  status?: MessageStatus;
  /** Filtre « contient » sur le destinataire. */
  to?: string;
  page?: number;
  /** 1–100 (30 par défaut). */
  limit?: number;
}

/** Filtres de `GET /v1/messages/history` (endpoint historique). */
export interface HistoryParams {
  channel?: Channel;
  status?: MessageStatus;
  page?: number;
}

/**
 * Page renvoyée par `GET /v1/messages/history`. Lignes brutes, non garanties
 * stables — préférez `messages.list()` pour tout nouveau code.
 */
export interface HistoryPage {
  messages: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pages: number;
}

/** Compteurs de limitation de débit lus sur la dernière réponse. */
export interface RateLimitInfo {
  /** Plafond de requêtes par fenêtre (`X-RateLimit-Limit`). */
  limit: number;
  /** Requêtes restantes dans la fenêtre (`X-RateLimit-Remaining`). */
  remaining: number;
  /** Fin de fenêtre, epoch en secondes (`X-RateLimit-Reset`). */
  reset: number;
}
