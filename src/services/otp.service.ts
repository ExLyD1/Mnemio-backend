import { randomInt, createHash, timingSafeEqual } from 'node:crypto';

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

export const generateOtpCode = (): string => {
    const n = randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
};

export const hashOtp = (code: string): string =>
    createHash('sha256').update(code).digest('hex');

export const verifyOtp = (code: string, codeHash: string): boolean => {
    const a = Buffer.from(hashOtp(code), 'hex');
    const b = Buffer.from(codeHash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
};

export const otpExpiry = (): Date => {
    const d = new Date();
    d.setUTCMinutes(d.getUTCMinutes() + OTP_TTL_MINUTES);
    return d;
};
