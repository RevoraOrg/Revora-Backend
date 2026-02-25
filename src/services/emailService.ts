// src/services/emailService.ts

export interface EmailOptions {
    to: string | string[];
    subject: string;
    body: string;
    template?: string; // Optional template identifier
    context?: Record<string, any>; // Optional data for the template
}

export interface EmailService {
    sendMail(options: EmailOptions): Promise<void>;
}

export class SmtpEmailService implements EmailService {
    private transporter: any;

    constructor() {
        // Rely on dynamic require so that package.json doesn't need modification here.
        // Maintainers will install nodemailer.
        let nodemailer: any;
        try {
            nodemailer = require('nodemailer');
        } catch (error) {
            console.warn('nodemailer is not installed. SMTP email service will not work until it is installed.');
            return;
        }

        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'localhost',
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
    }

    async sendMail(options: EmailOptions): Promise<void> {
        if (!this.transporter) {
            throw new Error('Email transport is not initialized. Ensure nodemailer is installed.');
        }

        const { to, subject, body } = options;

        const mailOptions = {
            from: process.env.EMAIL_FROM || '"Revora" <noreply@revora.app>',
            to: Array.isArray(to) ? to.join(', ') : to,
            subject,
            text: body,
        };

        await this.transporter.sendMail(mailOptions);
    }
}

// Factory export
export const createEmailService = (): EmailService => {
    const provider = process.env.EMAIL_PROVIDER || 'smtp';

    if (provider === 'smtp') {
        return new SmtpEmailService();
    }

    // Potential handlers for 'sendgrid' and 'ses' can be added here

    throw new Error(`Unsupported email provider: ${provider}`);
};
