import { EmailOptions, EmailService, SmtpEmailService, createEmailService } from './emailService';

describe('EmailService', () => {
  const originalEnv = process.env;
  let mockSendMail: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    
    mockSendMail = jest.fn().mockResolvedValue(true);
    
    // Mock nodemailer virtually since it's not installed in package.json
    jest.doMock('nodemailer', () => ({
      createTransport: jest.fn().mockReturnValue({
        sendMail: mockSendMail,
      }),
    }), { virtual: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('SmtpEmailService', () => {
    it('initializes and sends email successfully', async () => {
      const { SmtpEmailService } = require('./emailService');
      const service = new SmtpEmailService();

      await service.sendMail({
        to: 'test@example.com',
        subject: 'Test Subject',
        body: 'Test Body',
      });

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'test@example.com',
        subject: 'Test Subject',
        text: 'Test Body',
      }));
    });
    
    it('throws error when no transporter is initialized due to missing module', async () => {
      // Override the mock to throw an error simulating module not found
      jest.doMock('nodemailer', () => {
        throw new Error('Cannot find module nodemailer');
      }, { virtual: true });
      
      const { SmtpEmailService } = require('./emailService');
      
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new SmtpEmailService();
      
      expect(warnSpy).toHaveBeenCalledWith('nodemailer is not installed. SMTP email service will not work until it is installed.');
      
      await expect(service.sendMail({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      })).rejects.toThrow('Email transport is not initialized. Ensure nodemailer is installed.');
      
      warnSpy.mockRestore();
    });
  });

  describe('createEmailService factory', () => {
    it('creates an SmtpEmailService when provider is smtp', () => {
      process.env.EMAIL_PROVIDER = 'smtp';
      const { createEmailService, SmtpEmailService } = require('./emailService');
      const service = createEmailService();
      expect(service).toBeInstanceOf(SmtpEmailService);
    });

    it('throws error for unsupported provider', () => {
      process.env.EMAIL_PROVIDER = 'unknown';
      const { createEmailService } = require('./emailService');
      expect(() => createEmailService()).toThrow('Unsupported email provider: unknown');
    });
  });
});
