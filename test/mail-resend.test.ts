import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Point the env at resend before importing the module so the branch evaluates.
process.env.MAIL_PROVIDER = 'resend';
process.env.MAIL_PROVIDER_API_KEY = 're_test_key_12345';
process.env.MAIL_FROM = 'Mnemio <support@mnemio.xyz>';

const { sendOtpEmail } = await import('../src/services/mail.service.js');

describe('mail.service / sendViaResend', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('POSTs to the Resend emails endpoint with the bearer token + JSON body', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'eml-1' }) });
        await sendOtpEmail('alice@example.com', '123456');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0]!;
        expect(url).toBe('https://api.resend.com/emails');
        expect(opts.method).toBe('POST');
        expect(opts.headers.authorization).toBe('Bearer re_test_key_12345');
        const body = JSON.parse(opts.body);
        expect(body.from).toBe('Mnemio <support@mnemio.xyz>');
        expect(body.to).toEqual(['alice@example.com']);
        expect(body.subject).toBe('Your Mnemio verification code');
        expect(body.text).toContain('123456');
        expect(body.html).toContain('123456');
    });

    it('throws with the upstream message when Resend returns non-2xx', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ message: 'Domain not verified' }),
        });
        await expect(sendOtpEmail('a@b.test', '000000')).rejects.toThrow(
            /Resend rejected the send \(403\): Domain not verified/,
        );
    });

    it('throws a clear error when the request times out', async () => {
        // Simulate an abort by returning a rejected promise mimicking AbortError.
        fetchMock.mockImplementation(() => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        });
        await expect(sendOtpEmail('a@b.test', '000000')).rejects.toThrow(
            /Resend send timed out/,
        );
    });
});
