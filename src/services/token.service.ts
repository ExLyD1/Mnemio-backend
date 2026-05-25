import { randomBytes, createHash } from 'node:crypto';
import { env } from '../config/env.js';

const REFRESH_BYTES = 32; // 256 bits

export const generateOpaqueToken = (): string =>
    randomBytes(REFRESH_BYTES).toString('base64url');

export const hashToken = (token: string): string =>
    createHash('sha256').update(token).digest('hex');

export const refreshTokenExpiry = (): Date => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + env.JWT_REFRESH_TTL_DAYS);
    return d;
};
