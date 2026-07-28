
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { env } from '../config/env';
import { EmailDeliverabilityService } from './emailDeliverabilityService';
import { Errors } from '../lib/errors';

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

export type EmailProviderName = 'sendgrid' | 'smtp' | 'mock';

export interface EmailServiceConfig {
  NODE_ENV?: string;
  EMAIL_PROVIDER?: string;
  SENDGRID_API_KEY?: string;
  FROM_EMAIL?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string | number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
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

interface SmtpSocket {
  write(data: string | Buffer): boolean;
  end(): void;
  destroy(error?: Error): void;
  setEncoding?(encoding: BufferEncoding): void;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

export interface SmtpConnectionFactory {
  connect(host: string, port: number): Promise<SmtpSocket>;
  startTls(socket: SmtpSocket, host: string): Promise<SmtpSocket>;
}

export interface SmtpEmailProviderOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  defaultFrom: string;
  connectionFactory?: SmtpConnectionFactory;
  requireStartTls?: boolean;
}

const defaultSmtpConnectionFactory: SmtpConnectionFactory = {
  async connect(host: string, port: number): Promise<SmtpSocket> {
    const socket = net.connect({ host, port });
    socket.setEncoding('utf8');
    await once(socket, 'connect');
    return socket;
  },
  async startTls(socket: SmtpSocket, host: string): Promise<SmtpSocket> {
    const secureSocket = tls.connect({ socket: socket as net.Socket, servername: host });
    secureSocket.setEncoding('utf8');
    await once(secureSocket, 'secureConnect');
    return secureSocket;
  },
};

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function assertSmtpSecurity(options: SmtpEmailProviderOptions): void {
  if (!options.host) {
    throw new Error('SMTP_HOST is required for EMAIL_PROVIDER=smtp');
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port for EMAIL_PROVIDER=smtp');
  }
  if ((options.user && !options.pass) || (!options.user && options.pass)) {
    throw new Error('SMTP_USER and SMTP_PASS must be provided together');
  }

  const requiresAuth = Boolean(options.user && options.pass);
  if (requiresAuth && options.requireStartTls === false && !isLoopbackHost(options.host)) {
    throw new Error('SMTP plaintext authentication is only permitted for loopback hosts');
  }
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly host: string;
  private readonly port: number;
  private readonly user?: string;
  private readonly pass?: string;
  private readonly defaultFrom: string;
  private readonly connectionFactory: SmtpConnectionFactory;
  private readonly requireStartTls: boolean;

  constructor(options: SmtpEmailProviderOptions) {
    assertSmtpSecurity(options);
    this.host = options.host;
    this.port = options.port;
    this.user = options.user;
    this.pass = options.pass;
    this.defaultFrom = options.defaultFrom;
    this.connectionFactory = options.connectionFactory ?? defaultSmtpConnectionFactory;
    this.requireStartTls = options.requireStartTls ?? true;
  }

  /**
   * Sends a transactional message over SMTP.
   *
   * Security assumptions:
   * - STARTTLS is negotiated before credentials or message content are sent.
   * - AUTH PLAIN is only attempted after TLS; constructor guards prevent remote
   *   plaintext auth if a future caller disables STARTTLS for loopback-only tests.
   * - Message bodies are never logged by this provider.
   */
  async send(options: EmailOptions): Promise<void> {
    let socket = await this.connectionFactory.connect(this.host, this.port);
    try {
      const session = new SmtpSession(socket);
      await session.expect([220], 'SMTP greeting');
      await session.command(`EHLO ${sanitizeEhloDomain(process.env.HOSTNAME ?? 'localhost')}`, [250], 'SMTP EHLO');

      if (this.requireStartTls) {
        await session.command('STARTTLS', [220], 'SMTP STARTTLS');
        socket = await this.connectionFactory.startTls(socket, this.host);
        session.replaceSocket(socket);
        await session.command(`EHLO ${sanitizeEhloDomain(process.env.HOSTNAME ?? 'localhost')}`, [250], 'SMTP EHLO after STARTTLS');
      }

      if (this.user && this.pass) {
        const authPayload = Buffer.from(`\0${this.user}\0${this.pass}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${authPayload}`, [235], 'SMTP authentication');
      }

      const from = options.from || this.defaultFrom;
      await session.command(`MAIL FROM:<${assertSafeAddress(from)}>`, [250], 'SMTP MAIL FROM');
      await session.command(`RCPT TO:<${assertSafeAddress(options.to)}>`, [250, 251], 'SMTP RCPT TO');
      await session.command('DATA', [354], 'SMTP DATA');
      await session.command(formatMessage(from, options), [250], 'SMTP message body');
      await session.command('QUIT', [221, 250], 'SMTP QUIT');
      socket.end();
    } catch (error) {
      socket.destroy(error instanceof Error ? error : undefined);
      throw error;
    }
  }
}

class SmtpSession {
  private buffer = '';
  private waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private dataListener = (chunk: Buffer | string) => this.onData(chunk);
  private errorListener = (error: Error) => this.rejectAll(error);
  private closeListener = () => this.rejectAll(new Error('SMTP connection closed'));

  constructor(private socket: SmtpSocket) {
    this.attach(socket);
  }

  replaceSocket(socket: SmtpSocket): void {
    this.detach();
    this.socket = socket;
    this.buffer = '';
    this.attach(socket);
  }

  async command(command: string, expectedCodes: number[], context: string): Promise<string> {
    this.socket.write(`${command}\r\n`);
    return this.expect(expectedCodes, context);
  }

  async expect(expectedCodes: number[], context: string): Promise<string> {
    const line = await this.readResponse();
    const code = Number(line.slice(0, 3));
    if (!expectedCodes.includes(code)) {
      throw new Error(`${context} failed with SMTP status ${Number.isNaN(code) ? 'unknown' : code}`);
    }
    return line;
  }

  private attach(socket: SmtpSocket): void {
    socket.setEncoding?.('utf8');
    socket.on('data', this.dataListener);
    socket.on('error', this.errorListener);
    socket.on('close', this.closeListener);
  }

  private detach(): void {
    this.socket.off('data', this.dataListener);
    this.socket.off('error', this.errorListener);
    this.socket.off('close', this.closeListener);
  }

  private readResponse(): Promise<string> {
    const completed = this.takeCompletedResponse();
    if (completed) {
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let completed = this.takeCompletedResponse();
    while (completed && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve(completed);
      completed = this.takeCompletedResponse();
    }
  }

  private takeCompletedResponse(): string | null {
    const lines = this.buffer.split(/\r?\n/);
    if (!this.buffer.endsWith('\n')) {
      lines.pop();
    }
    let consumed = 0;
    let lastLine = '';
    for (const line of lines) {
      if (!line) {
        consumed += 1;
        continue;
      }
      lastLine = line;
      consumed += line.length + 2;
      if (/^\d{3} /.test(line)) {
        this.buffer = this.buffer.slice(consumed);
        return lastLine;
      }
    }
    return null;
  }

  private rejectAll(error: Error): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }
}

export class MockEmailProvider implements EmailProvider {
  async send(options: EmailOptions): Promise<void> {
    console.info(`[Email Mock] Accepted transactional email for ${options.to} with subject "${options.subject}"`);
  }
}

export class EmailService {
  private deliverabilityService?: EmailDeliverabilityService;

  constructor(
    private provider: EmailProvider,
    deliverabilityService?: EmailDeliverabilityService,
  ) {
    this.deliverabilityService = deliverabilityService;
  }

  /**
   * Set or replace the deliverability service (useful for late binding).
   */
  setDeliverabilityService(service: EmailDeliverabilityService | undefined): void {
    this.deliverabilityService = service;
  }

  /**
   * Send a transactional email.
   *
   * When a deliverability service is configured:
   * 1. Checks the suppression list before sending — throws FORBIDDEN if suppressed.
   * 2. After successful send, records the send event for domain reputation tracking.
   *
   * Security:
   * - Suppressed recipients are rejected before any provider API call is made,
   *   preventing unnecessary exposure of the message body to the provider.
   * - The suppression check is always performed when deliverability is enabled.
   */
  async sendMail(to: string, subject: string, body: string, template?: string): Promise<void> {
    // Suppression check (when deliverability tracking is enabled)
    if (this.deliverabilityService?.enabled) {
      const suppressed = await this.deliverabilityService.isSuppressed(to);
      if (suppressed) {
        throw Errors.forbidden(`Recipient ${to} is suppressed`);
      }
    }

    await this.provider.send({ to, subject, body, template });

    // Record successful send for domain reputation tracking
    if (this.deliverabilityService?.enabled) {
      const domain = extractEmailDomain(to);
      const providerName = this.getProviderName();
      await this.deliverabilityService.recordSend(to, domain, providerName).catch((err) => {
        console.error('[EmailService] Failed to record send event:', err);
      });
    }
  }

  /**
   * Best-effort provider name detection.
   */
  private getProviderName(): string {
    if (this.provider instanceof SendGridEmailProvider) return 'sendgrid';
    if (this.provider instanceof SmtpEmailProvider) return 'smtp';
    return 'mock';
  }
}

/**
 * Extract domain from an email address.
 */
function extractEmailDomain(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return 'unknown';
  return email.slice(atIndex + 1).toLowerCase();
}

/**
 * Creates an EmailService based on the provided configuration.
 *
 * Security assumptions:
 * - Production operators must explicitly choose sendgrid or smtp.
 * - Mock delivery is development/test-only and never logs message bodies.
 * - SMTP credentials are only sent after STARTTLS unless the target is loopback.
 */
export function createEmailService(config: EmailServiceConfig = { ...env, ...process.env }): EmailService {
  const provider = selectProvider(config);
  const fromEmail = config.FROM_EMAIL || 'noreply@revora.com';

  if (provider === 'mock') {
    if (config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
      throw new Error('EMAIL_PROVIDER=mock is only permitted in development or test');
    }
    return new EmailService(new MockEmailProvider());
  }

  if (provider === 'sendgrid') {
    if (!config.SENDGRID_API_KEY) {
      throw new Error('SENDGRID_API_KEY is required for EMAIL_PROVIDER=sendgrid');
    }
    return new EmailService(new SendGridEmailProvider(config.SENDGRID_API_KEY, fromEmail));
  }

  return new EmailService(new SmtpEmailProvider({
    host: config.SMTP_HOST ?? '',
    port: Number(config.SMTP_PORT ?? 587),
    user: config.SMTP_USER,
    pass: config.SMTP_PASS,
    defaultFrom: fromEmail,
  }));
}

export const emailService = createEmailService();

function selectProvider(config: EmailServiceConfig): EmailProviderName {
  const explicitProvider = config.EMAIL_PROVIDER?.toLowerCase();
  if (explicitProvider) {
    if (explicitProvider === 'sendgrid' || explicitProvider === 'smtp' || explicitProvider === 'mock') {
      return explicitProvider;
    }
    throw new Error('EMAIL_PROVIDER must be one of sendgrid, smtp, or mock');
  }
  return config.SENDGRID_API_KEY ? 'sendgrid' : 'mock';
}

function sanitizeEhloDomain(value: string): string {
  return value.replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 253) || 'localhost';
}

function assertSafeAddress(address: string): string {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) || /[\r\n]/.test(address)) {
    throw new Error('Invalid email address');
  }
  return address;
}

function formatMessage(from: string, options: EmailOptions): string {
  const safeSubject = options.subject.replace(/[\r\n]+/g, ' ').trim();
  const body = options.body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return [
    `From: <${assertSafeAddress(from)}>`,
    `To: <${assertSafeAddress(options.to)}>`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    body,
    '.',
  ].join('\r\n');
}
