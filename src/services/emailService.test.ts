
import { EmailService, SendGridEmailProvider, EmailProvider } from './emailService';

describe('EmailService', () => {
    let mockProvider: EmailProvider;
    let emailService: EmailService;

    beforeEach(() => {
        mockProvider = {
            send: jest.fn().mockResolvedValue(undefined),
        };
        emailService = new EmailService(mockProvider);
    });

    it('should call provider.send with correct options', async () => {
        const to = 'test@example.com';
        const subject = 'Test Subject';
        const body = 'Test Body';
        const template = 'test-template';

        await emailService.sendMail(to, subject, body, template);

        expect(mockProvider.send).toHaveBeenCalledWith({
            to,
            subject,
            body,
            template,
        });
    });
});

describe('SendGridEmailProvider', () => {
    const apiKey = 'test-api-key';
    const defaultFrom = 'noreply@example.com';
    let providerHost: SendGridEmailProvider;

    beforeEach(() => {
        // Reset global fetch mock if it exists
        global.fetch = jest.fn() as jest.Mock;
        providerHost = new SendGridEmailProvider(apiKey, defaultFrom);
    });

    it('should send a POST request to SendGrid API', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });

        await providerHost.send({
            to: 'recipient@example.com',
            subject: 'Hello',
            body: 'World',
        });

        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.sendgrid.com/v3/mail/send',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: expect.stringContaining('"to":[{"email":"recipient@example.com"}]'),
            })
        );
    });

    it('should throw an error if SendGrid API returns an error', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ errors: [{ message: 'Unauthorized' }] }),
        });

        await expect(
            providerHost.send({
                to: 'recipient@example.com',
                subject: 'Hello',
                body: 'World',
            })
        ).rejects.toThrow('SendGrid error: 401');
    });
});
