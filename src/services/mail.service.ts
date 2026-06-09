import { env } from '../config/env.js';

export type MailMessage = {
    to: string;
    subject: string;
    text: string;
    html?: string;
};

// ---------- console (dev/default) ----------

const sendViaConsole = async (msg: MailMessage): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('\n========== [mail:console] ==========');
    console.log(`From:    ${env.MAIL_FROM}`);
    console.log(`To:      ${msg.to}`);
    console.log(`Subject: ${msg.subject}`);
    console.log('---');
    console.log(msg.text);
    console.log('====================================\n');
};

// ---------- resend ----------

// Resend's single-endpoint REST API. Plain fetch keeps the dep footprint
// lean — the SDK only adds types we already write here.
const RESEND_URL = 'https://api.resend.com/emails';

// Mail send happens inline with /auth/register, so a slow upstream is
// user-visible. Bound the wait so a Resend outage doesn't hang signups.
const RESEND_TIMEOUT_MS = 6_000;

const sendViaResend = async (msg: MailMessage): Promise<void> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

    try {
        const res = await fetch(RESEND_URL, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${env.MAIL_PROVIDER_API_KEY}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                from: env.MAIL_FROM,
                to: [msg.to],
                subject: msg.subject,
                text: msg.text,
                ...(msg.html ? { html: msg.html } : {}),
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            // Resend returns { name, message, statusCode } on failure.
            const body = (await res.json().catch(() => ({}))) as {
                message?: string;
            };
            throw new Error(
                `Resend rejected the send (${res.status}): ${body.message ?? 'no message'}`,
            );
        }
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            throw new Error('Resend send timed out');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
};

// ---------- public api ----------

export const sendMail = async (msg: MailMessage): Promise<void> => {
    if (env.MAIL_PROVIDER === 'resend') return sendViaResend(msg);
    return sendViaConsole(msg);
};

// ---------- OTP template ----------

const otpHtml = (code: string): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Your Mnemio verification code</title></head>
<body style="font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#f6f7f9;margin:0;padding:32px 16px;color:#1a1a1a">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
    <tr><td>
      <h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600">Your Mnemio code</h1>
      <p style="margin:0 0 24px 0;font-size:14px;line-height:1.5;color:#555">
        Use the code below to finish signing in. It expires in 10 minutes.
      </p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f1f3f5;border-radius:8px;padding:16px 24px;text-align:center;font-family:ui-monospace,SFMono-Regular,monospace">
        ${code}
      </div>
      <p style="margin:24px 0 0 0;font-size:12px;line-height:1.5;color:#999">
        If you didn't request this, you can ignore this email — someone may have entered your address by mistake.
      </p>
    </td></tr>
  </table>
</body></html>`;

export const sendOtpEmail = async (to: string, code: string): Promise<void> => {
    await sendMail({
        to,
        subject: 'Your Mnemio verification code',
        text:
            `Your Mnemio verification code is: ${code}\n\n` +
            `This code expires in 10 minutes. If you did not request this, ignore this email.`,
        html: otpHtml(code),
    });
};
