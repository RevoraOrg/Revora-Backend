
import { EventEmitter } from 'node:events';
import {
    EmailService,
    SendGridEmailProvider,
    EmailProvider,
    SmtpEmailProvider,
    SmtpConnectionFactory,
    createEmailService,
} from './emailService';

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

class FakeSmtpSocket extends EventEmitter {
    public writes: string[] = [];

    constructor(private readonly responder: (command: string) => string | undefined) {
        super();
    }

    write(data: string | Buffer): boolean {
        const command = data.toString();
        this.writes.push(command);
        const response = this.responder(command);
        if (response) {
            setImmediate(() => this.emit('data', response));
        }
        return true;
    }

    end(): void {
        this.emit('close');
    }

    destroy(error?: Error): void {
        if (error) {
            this.emit('error', error);
        }
        this.emit('close');
    }

    setEncoding(): void {}
}

function createSmtpFactory(options?: {
    startTlsResponse?: string;
    authResponse?: string;
}): SmtpConnectionFactory & { plainSocket: FakeSmtpSocket; tlsSocket: FakeSmtpSocket; startTls: jest.Mock } {
    const plainSocket = new FakeSmtpSocket((command) => {
        if (command.startsWith('EHLO')) return '250-smtp.example.com\r\n250 STARTTLS\r\n';
        if (command.startsWith('STARTTLS')) return options?.startTlsResponse ?? '220 Ready to start TLS\r\n';
        return undefined;
    });
    const tlsSocket = new FakeSmtpSocket((command) => {
        if (command.startsWith('EHLO')) return '250-smtp.example.com\r\n250 AUTH PLAIN\r\n';
        if (command.startsWith('AUTH PLAIN')) return options?.authResponse ?? '235 Authentication successful\r\n';
        if (command.startsWith('MAIL FROM')) return '250 Sender accepted\r\n';
        if (command.startsWith('RCPT TO')) return '250 Recipient accepted\r\n';
        if (command.startsWith('DATA')) return '354 End data with <CR><LF>.<CR><LF>\r\n';
        if (command.startsWith('From:')) return '250 Message accepted\r\n';
        if (command.startsWith('QUIT')) return '221 Bye\r\n';
        return undefined;
    });

    return {
        plainSocket,
        tlsSocket,
        startTls: jest.fn().mockResolvedValue(tlsSocket),
        connect: jest.fn().mockImplementation(async () => {
            setImmediate(() => plainSocket.emit('data', '220 smtp.example.com ESMTP\r\n'));
            return plainSocket;
        }),
    };
}

describe('SmtpEmailProvider', () => {
    it('requires STARTTLS before sending credentials or message content', async () => {
        const factory = createSmtpFactory();
        const provider = new SmtpEmailProvider({
            host: 'smtp.example.com',
            port: 587,
            user: 'smtp-user',
            pass: 'smtp-pass',
            defaultFrom: 'noreply@example.com',
            connectionFactory: factory,
        });

        await provider.send({
            to: 'recipient@example.com',
            subject: 'Reset password',
            body: 'Use this reset link',
        });

        expect(factory.plainSocket.writes).toEqual([
            expect.stringMatching(/^EHLO /),
            'STARTTLS\r\n',
        ]);
        expect(factory.startTls).toHaveBeenCalledWith(factory.plainSocket, 'smtp.example.com');
        expect(factory.tlsSocket.writes[0]).toEqual(expect.stringMatching(/^EHLO /));
        expect(factory.tlsSocket.writes.some((write) => write.startsWith('AUTH PLAIN'))).toBe(true);
        expect(factory.plainSocket.writes.join('')).not.toContain('smtp-pass');
        expect(factory.plainSocket.writes.join('')).not.toContain('Use this reset link');
    });

    it('fails closed when STARTTLS is rejected by the relay', async () => {
        const factory = createSmtpFactory({ startTlsResponse: '454 TLS not available\r\n' });
        const provider = new SmtpEmailProvider({
            host: 'smtp.example.com',
            port: 587,
            user: 'smtp-user',
            pass: 'smtp-pass',
            defaultFrom: 'noreply@example.com',
            connectionFactory: factory,
        });

        await expect(provider.send({
            to: 'recipient@example.com',
            subject: 'Reset password',
            body: 'secret-reset-token',
        })).rejects.toThrow('SMTP STARTTLS failed with SMTP status 454');

        expect(factory.startTls).not.toHaveBeenCalled();
        expect(factory.plainSocket.writes.join('')).not.toContain('secret-reset-token');
    });

    it('surfaces SMTP authentication failures without retrying plaintext auth', async () => {
        const factory = createSmtpFactory({ authResponse: '535 Authentication failed\r\n' });
        const provider = new SmtpEmailProvider({
            host: 'smtp.example.com',
            port: 587,
            user: 'smtp-user',
            pass: 'smtp-pass',
            defaultFrom: 'noreply@example.com',
            connectionFactory: factory,
        });

        await expect(provider.send({
            to: 'recipient@example.com',
            subject: 'Reset password',
            body: 'body',
        })).rejects.toThrow('SMTP authentication failed with SMTP status 535');

        expect(factory.plainSocket.writes.join('')).not.toContain('AUTH PLAIN');
    });

    it('rejects plaintext authentication on non-loopback hosts', () => {
        expect(() => new SmtpEmailProvider({
            host: 'smtp.example.com',
            port: 25,
            user: 'smtp-user',
            pass: 'smtp-pass',
            defaultFrom: 'noreply@example.com',
            requireStartTls: false,
        })).toThrow('SMTP plaintext authentication is only permitted for loopback hosts');
    });
});

describe('createEmailService', () => {
    it('refuses mock delivery outside development and test', () => {
        expect(() => createEmailService({
            NODE_ENV: 'production',
            EMAIL_PROVIDER: 'mock',
        })).toThrow('EMAIL_PROVIDER=mock is only permitted in development or test');
    });

    it('does not log message bodies when using the mock provider', async () => {
        const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
        const service = createEmailService({
            NODE_ENV: 'development',
            EMAIL_PROVIDER: 'mock',
        });

        await service.sendMail(
            'recipient@example.com',
            'Password reset',
            'reset-token-should-not-appear',
        );

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('reset-token-should-not-appear');
    });

    it('selects SMTP when EMAIL_PROVIDER=smtp', () => {
        const service = createEmailService({
            NODE_ENV: 'production',
            EMAIL_PROVIDER: 'smtp',
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: 587,
            SMTP_USER: 'smtp-user',
            SMTP_PASS: 'smtp-pass',
            FROM_EMAIL: 'noreply@example.com',
        });

        expect(service).toBeInstanceOf(EmailService);
    });
});
