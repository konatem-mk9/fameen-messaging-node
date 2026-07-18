export { FameenMessaging, type FameenMessagingOptions } from './client';
export {
  FameenError,
  FameenApiError,
  FameenConnectionError,
  WebhookVerificationError,
  type FameenErrorCode,
} from './errors';
export { verifyWebhookSignature, constructWebhookEvent } from './webhooks';
export { fileAttachment, toBase64 } from './media';
export type {
  Channel,
  MediaClass,
  MediaContent,
  Attachment,
  MessageStatus,
  MessageResource,
  MessageList,
  WalletBalance,
  WebhookEvent,
  WebhookEventType,
  CreateMessageParams,
  SendParams,
  RequestOptions,
  ListMessagesParams,
  HistoryParams,
  HistoryPage,
  RateLimitInfo,
} from './types';
