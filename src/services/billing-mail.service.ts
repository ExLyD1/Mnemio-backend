import { env } from '../config/env.js';
import { sendMail } from './mail.service.js';
import * as authRepo from '../repositories/auth.repository.js';
import { capFor } from './ai.budget.service.js';
import { lowestUnitToMajor } from '../shared/mappers.billing.js';
import type { SubscriptionRow } from '../repositories/subscription.repository.js';
import type { FastifyBaseLogger } from 'fastify';

export type BillingEmail = 'trial-ending' | 'payment-failed' | 'cancelled';
const escapeHtml = (s: string) =>
    s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
const date = (d: Date) =>
    new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(d);
const money = (amount: number, currency: string) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
        lowestUnitToMajor(amount, currency),
    );
const footer =
    "You're getting this because you have a Mnemio account. Payments are processed by Paddle.com, our merchant of record.";

export const billingEmail = (kind: BillingEmail, row: SubscriptionRow) => {
    let subject: string;
    let body: string;
    let cta: string;
    let path = '/settings/billing';
    if (kind === 'trial-ending') {
        if (!row.trialEnd) {
            throw new Error('Trial end is required for a reminder');
        }
        const end = date(row.trialEnd);
        subject = `Your free trial ends ${end}`;
        const charge =
            row.priceAmount !== null && row.currency
                ? `Your charge will be ${money(row.priceAmount, row.currency)} on ${end}.`
                : `Your first charge is on ${end}. Check your subscription for the charge amount.`;
        body = `${charge}\nCancel before then in Settings → Subscription to avoid being charged.`;
        cta = 'Manage subscription';
    } else if (kind === 'payment-failed') {
        subject = "We couldn't charge your card";
        const charge =
            row.pastDueAmount !== null && row.pastDueCurrency
                ? `The payment of ${money(row.pastDueAmount, row.pastDueCurrency)}`
                : 'Your payment';
        body = `${charge} failed${row.pastDueAt ? ` on ${date(row.pastDueAt)}` : ''}.\nPremium stays on until ${date(row.currentPeriodEnd)}.\nYour decks stay.`;
        cta = 'Update card';
        path += '?action=update-card';
    } else {
        subject = 'Your subscription is cancelled';
        body = `Premium stays on until ${date(row.currentPeriodEnd)}.\nAfter that, the free plan includes ${capFor('chat', 'free')} AI chat requests a day.\nYour decks stay.`;
        cta = 'Resume subscription';
    }
    const url = new URL(path, env.APP_URL).toString();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:32px 16px;background:#E9E6DF;font-family:Arial,sans-serif;color:#3D4A3B"><table role="presentation" align="center" width="100%" style="max-width:600px;background:#fff;border-radius:16px"><tr><td style="padding:32px 40px"><div style="font-size:24px;color:#2E6B4A">Mnemio</div><h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:400">${escapeHtml(subject)}</h1>${body
        .split('\n')
        .map((p) => `<p style="font-size:16px;line-height:1.6">${escapeHtml(p)}</p>`)
        .join(
            '',
        )}<p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2E6B4A;color:white;border-radius:12px;padding:13px 24px;text-decoration:none">${escapeHtml(cta)}</a></p><p style="font-size:12px;line-height:1.5;color:#8A9387">${escapeHtml(footer)}</p></td></tr></table></body></html>`;
    return { subject, text: `${subject}\n\n${body}\n\n${cta}: ${url}\n\n${footer}`, html };
};

/** Never rejects: mail outages cannot fail an API response or webhook ACK. */
export const sendBillingEmail = async (
    kind: BillingEmail,
    row: SubscriptionRow,
    log?: Pick<FastifyBaseLogger, 'warn'>,
    recipient?: string,
): Promise<void> => {
    try {
        const to = recipient ?? (await authRepo.findUserById(row.userId))?.email;
        if (to) {
            await sendMail({ to, ...billingEmail(kind, row) });
        }
    } catch (err) {
        if (log) {
            log.warn({ err, kind }, 'billing email failed');
        } else {
            // eslint-disable-next-line no-console -- no app logger is available in deferred service emits
            console.warn('billing email failed', { kind, err });
        }
    }
};
