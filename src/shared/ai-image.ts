import type { MultipartFile } from '@fastify/multipart';
import { env } from '../config/env.js';
import { AiImageTooLargeError, AiImageUnsupportedTypeError } from './errors.js';
import { AI_IMAGE_MIME, type AiImageInput } from '../services/ai.provider.js';

/**
 * Validates and buffers a multipart image file into base64 for a vision
 * model call. Never written to disk — the buffer is discarded once the
 * request finishes. Shared by POST /ai/deck-from-image and image-attached
 * chat turns.
 */
export const readAiImage = async (file: MultipartFile): Promise<AiImageInput> => {
    const mimetype = file.mimetype.toLowerCase();
    if (!(AI_IMAGE_MIME as readonly string[]).includes(mimetype)) {
        // Drain the stream so the request doesn't hang even though we reject.
        await file.toBuffer().catch(() => undefined);
        throw new AiImageUnsupportedTypeError([...AI_IMAGE_MIME]);
    }

    const buffer = await file.toBuffer();
    if (buffer.length > env.AI_IMAGE_MAX_BYTES || file.file.truncated) {
        throw new AiImageTooLargeError(env.AI_IMAGE_MAX_BYTES);
    }

    return {
        mediaType: mimetype as AiImageInput['mediaType'],
        dataBase64: buffer.toString('base64'),
    };
};

/**
 * Extracts the plain-text fields from a multipart request alongside the
 * file part (`file.fields` includes every part of the form, file and
 * non-file alike). Used to feed the rest of a multipart body into a Zod
 * schema the same way a JSON body would be.
 */
export const multipartTextFields = (file: MultipartFile): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const entry of Object.values(file.fields)) {
        const list = Array.isArray(entry) ? entry : [entry];
        for (const part of list) {
            if (part && part.type === 'field' && typeof part.value === 'string') {
                out[part.fieldname] = part.value;
            }
        }
    }
    return out;
};
