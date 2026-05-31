import { env } from '../config/env.js';

export type MailMessage = {
    to: string;
    subject: string;
    text: string;
    html?: string;
};

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

export const sendMail = async (msg: MailMessage): Promise<void> => {
    if (env.MAIL_PROVIDER === 'console') return sendViaConsole(msg);

    // Future: branch on env.MAIL_PROVIDER === 'resend' etc.
    return sendViaConsole(msg);
};

export const sendOtpEmail = async (to: string, code: string): Promise<void> => {
    await sendMail({
        to,
        subject: 'Your Mnemio verification code',
        text:
            `Your Mnemio verification code is: ${code}\n\n` +
            `This code expires in 10 minutes. If you did not request this, ignore this email.`,
    });
};
