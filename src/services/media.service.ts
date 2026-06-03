/**
 * Local-disk media storage for MVP. Production should swap to S3-compatible
 * storage via presigned PUT URLs:
 *
 *   1) Backend signs a PUT URL for `s3://bucket/<userId>/<uuid>.<ext>`.
 *   2) Returns { putUrl, publicUrl } from POST /media/uploads.
 *   3) FE uploads the bytes directly to S3 (no proxying through the API).
 *   4) FE patches the card / user with the publicUrl.
 *
 * The endpoint *shape* stays the same — only the storage adapter changes.
 * `MEDIA_STORAGE=local` lets us ship without external infra.
 */
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { env } from '../config/env.js';
import { BadRequestError, UnprocessableError } from '../shared/errors.js';
import { MIME_ALLOWLIST, type MediaKind } from '../schemas/media.schema.js';
import * as usersRepo from '../repositories/users.repository.js';
import { toPublicUser } from '../shared/mappers.js';

const MAX_BYTES: Record<MediaKind, number> = {
    avatar: env.MEDIA_MAX_AVATAR_BYTES,
    card_image: env.MEDIA_MAX_IMAGE_BYTES,
    card_audio: env.MEDIA_MAX_AUDIO_BYTES,
};

const ensureDir = async (dir: string) => {
    await fs.mkdir(dir, { recursive: true });
};

const extensionFromMime = (mime: string): string => {
    const map: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/wav': 'wav',
        'audio/ogg': 'ogg',
        'audio/webm': 'webm',
    };
    return map[mime.toLowerCase()] ?? 'bin';
};

export type StoredFile = {
    url: string;       // public URL — what FE stores in audioUrl/imageUrl/avatarUrl
    kind: MediaKind;
    size: number;
    mimeType: string;
};

export const uploadFile = async (
    userId: string,
    kind: MediaKind,
    file: MultipartFile,
): Promise<StoredFile> => {
    if (!MIME_ALLOWLIST[kind].test(file.mimetype)) {
        throw new BadRequestError(
            'MEDIA_BAD_MIME',
            `MIME type "${file.mimetype}" is not allowed for kind "${kind}"`,
        );
    }

    const ext = extensionFromMime(file.mimetype);
    const filename = `${randomUUID()}.${ext}`;
    const userDir = path.join(env.MEDIA_DIR, userId);
    const fullPath = path.join(userDir, filename);
    await ensureDir(userDir);

    // Cap upload size at the per-kind limit. multipart's truncated flag tells
    // us if it exceeded the request body limit; we also short-circuit early
    // here by tracking bytesWritten via the stream.
    let bytesWritten = 0;
    const limit = MAX_BYTES[kind];
    const writeStream = createWriteStream(fullPath);
    let overflow = false;
    file.file.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (bytesWritten > limit) overflow = true;
    });

    try {
        await pipeline(file.file, writeStream);
    } catch (err) {
        await fs.unlink(fullPath).catch(() => {});
        throw err;
    }

    if (overflow || file.file.truncated) {
        await fs.unlink(fullPath).catch(() => {});
        throw new UnprocessableError(
            'MEDIA_TOO_LARGE',
            `File exceeds the ${Math.round(limit / 1_000_000)} MB limit for ${kind}`,
        );
    }

    const url = `${env.MEDIA_PUBLIC_BASE}/${userId}/${filename}`;
    return { url, kind, size: bytesWritten, mimeType: file.mimetype };
};

/** Avatar upload has a side-effect on the User row. */
export const uploadAvatar = async (userId: string, file: MultipartFile) => {
    const stored = await uploadFile(userId, 'avatar', file);
    const user = await usersRepo.updateUser(userId, { avatarUrl: stored.url });
    return { ...stored, user: toPublicUser(user) };
};
