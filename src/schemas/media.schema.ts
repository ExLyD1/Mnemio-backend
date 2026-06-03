import { z } from 'zod';

export const MEDIA_KINDS = ['avatar', 'card_image', 'card_audio'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const uploadQuerySchema = z.object({
    kind: z.enum(MEDIA_KINDS),
});

export const MIME_ALLOWLIST: Record<MediaKind, RegExp> = {
    avatar: /^image\/(png|jpe?g|webp)$/i,
    card_image: /^image\/(png|jpe?g|webp|gif)$/i,
    card_audio: /^audio\/(mpeg|mp3|wav|ogg|webm)$/i,
};
