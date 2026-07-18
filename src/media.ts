import type { Attachment, MediaClass, MediaContent } from './types';

/**
 * Encode un contenu média en base64 pour le transport JSON.
 * Les chaînes sont supposées déjà encodées (base64 ou data-URI) et passent
 * telles quelles ; les octets bruts (`Buffer`/`Uint8Array`/`ArrayBuffer`) sont
 * convertis.
 */
export function toBase64(content: MediaContent): string {
  if (typeof content === 'string') return content;
  if (content instanceof ArrayBuffer) return Buffer.from(new Uint8Array(content)).toString('base64');
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
  }
  throw new TypeError('Contenu média invalide : attendu string base64, Buffer, Uint8Array ou ArrayBuffer.');
}

/** `true` si les paramètres portent au moins un média. */
export function hasMedia(params: { media?: MediaContent; attachments?: Attachment[] }): boolean {
  return params.media !== undefined || (Array.isArray(params.attachments) && params.attachments.length > 0);
}

/**
 * Prépare le corps JSON d'un envoi : encode en base64 le contenu de `media` et
 * de chaque `attachments[]`, en laissant les autres champs intacts.
 */
export function serializeSendBody<T extends { media?: MediaContent; attachments?: Attachment[] }>(
  params: T,
): Record<string, unknown> {
  const { media, attachments, ...rest } = params as Record<string, unknown> & {
    media?: MediaContent;
    attachments?: Attachment[];
  };
  const body: Record<string, unknown> = { ...rest };
  if (media !== undefined) body.media = toBase64(media);
  if (attachments && attachments.length) {
    body.attachments = attachments.map((a) => ({
      content: toBase64(a.content),
      filename: a.filename,
      contentType: a.contentType,
      type: a.type,
    }));
  }
  return body;
}

/**
 * Construit une pièce jointe depuis un fichier local (Node uniquement).
 *
 * ```ts
 * const att = await fileAttachment('./facture.pdf');
 * await fameen.email.send({ to: 'a@b.com', subject: 'Facture', message: '...', attachments: [att] });
 * ```
 */
export async function fileAttachment(
  path: string,
  opts: { filename?: string; contentType?: string; type?: MediaClass } = {},
): Promise<Attachment> {
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const content = await readFile(path);
  return {
    content,
    filename: opts.filename ?? basename(path),
    contentType: opts.contentType,
    type: opts.type,
  };
}
