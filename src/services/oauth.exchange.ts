import crypto from 'node:crypto';
import type { AuthResult } from './auth.service.js';

// Short-lived map of `exchangeCode → AuthResult` used between the OAuth
// callback and the FE's POST /auth/oauth/exchange. In-memory is fine for a
// single Railway instance; swap for Redis if/when we scale horizontally.
//
// TTL is intentionally tiny (60s) — the FE swaps the code immediately after
// the redirect. Stale entries get reaped lazily on read.
const TTL_MS = 60_000;

type Entry = { result: AuthResult; expiresAt: number };

const store = new Map<string, Entry>();

const newCode = (): string => crypto.randomBytes(24).toString('base64url');

const reapStale = () => {
    const now = Date.now();
    for (const [k, v] of store) {
        if (v.expiresAt < now) store.delete(k);
    }
};

export const stash = (result: AuthResult): string => {
    // Cheap reaper — called on every issue, so the table never bloats for
    // long even though we don't run a separate timer.
    reapStale();
    const code = newCode();
    store.set(code, { result, expiresAt: Date.now() + TTL_MS });
    return code;
};

export const consume = (code: string): AuthResult | null => {
    const entry = store.get(code);
    if (!entry) return null;
    store.delete(code);
    if (entry.expiresAt < Date.now()) return null;
    return entry.result;
};
