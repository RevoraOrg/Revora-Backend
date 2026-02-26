
export interface EmailOptions {
  to: string;
  subject: string;
  body: string;
  template?: string;
  from?: string;
}

export interface EmailProvider {
  send(options: EmailOptions): Promise<void>;
}

export class SendGridEmailProvider implements EmailProvider {
  private apiKey: string;
  private defaultFrom: string;

  constructor(apiKey: string, defaultFrom: string) {
    this.apiKey = apiKey;
    this.defaultFrom = defaultFrom;
  }

  async send(options: EmailOptions): Promise<void> {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: options.to }],
            subject: options.subject,
          },
        ],
        from: { email: options.from || this.defaultFrom },
        content: [
          {
            type: 'text/html',
            value: options.body,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`SendGrid error: ${response.status} ${JSON.stringify(errorData)}`);
    }
  }
}

export class EmailService {
  constructor(private provider: EmailProvider) {}

  async sendMail(to: string, subject: string, body: string, template?: string): Promise<void> {
    await this.provider.send({ to, subject, body, template });
  }
}

// Factory or instance based on env
import { env } from '../config/env';

/**
 * Creates an EmailService based on the provided configuration.
 * For now, only SendGrid is implemented.
 */
export function createEmailService(): EmailService {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'noreply@revora.com';

  if (!apiKey) {
    console.warn('SENDGRID_API_KEY is not defined. Email service will use a dummy provider.');
    return new EmailService({
      send: async (options) => {
        console.log(`[Email Mock] To: ${options.to}, Subject: ${options.subject}`);
      }
    });
  }

  return new EmailService(new SendGridEmailProvider(apiKey, fromEmail));
}

export const emailService = createEmailService();
