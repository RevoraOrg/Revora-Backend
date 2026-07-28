import { buildConfig } from './env';

describe('env config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should parse valid environment variables', () => {
    process.env.NODE_ENV = 'development';
    process.env.PORT = '3000';
    process.env.STELLAR_SERVER_SECRET = 'SA...'; // valid length

    const cfg = buildConfig();
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
  });

  it('should abort startup on missing required production variables', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`Process.exit called with ${code}`);
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'production';
    process.env.STELLAR_SERVER_SECRET = 'valid_secret';
    // Missing DATABASE_URL and JWT_SECRET

    try {
      buildConfig();
      fail('Expected buildConfig to throw');
    } catch (e: any) {
      expect(e.message).toBe('Process.exit called with 1');
    }
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('[FATAL]'));
    
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it('should require STELLAR_SERVER_SECRET outside test env', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`Process.exit called with ${code}`);
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'development';
    delete process.env.STELLAR_SERVER_SECRET;

    try {
      buildConfig();
      fail('Expected buildConfig to throw');
    } catch (e: any) {
      expect(e.message).toBe('Process.exit called with 1');
    }
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('[FATAL]'));
    
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it('should allow missing STELLAR_SERVER_SECRET in test env', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.STELLAR_SERVER_SECRET;

    const cfg = buildConfig();
    expect(cfg.STELLAR_SERVER_SECRET).toBeUndefined();
  });

  it('should parse ALLOWED_ORIGINS correctly', () => {
    process.env.NODE_ENV = 'development';
    process.env.STELLAR_SERVER_SECRET = 'valid';
    process.env.ALLOWED_ORIGINS = 'http://example.com, https://test.com ';

    const cfg = buildConfig();
    expect(cfg.ALLOWED_ORIGINS_ARRAY).toEqual(['http://example.com', 'https://test.com']);
  });

  it('should reject mock email provider in production', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`Process.exit called with ${code}`);
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/revora';
    process.env.JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long!';
    process.env.STELLAR_SERVER_SECRET = 'valid';
    process.env.EMAIL_PROVIDER = 'mock';

    expect(() => buildConfig()).toThrow('Process.exit called with 1');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('EMAIL_PROVIDER'));

    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it('should require SMTP_USER and SMTP_PASS together', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`Process.exit called with ${code}`);
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'test';
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'smtp-user';
    delete process.env.SMTP_PASS;

    expect(() => buildConfig()).toThrow('Process.exit called with 1');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('SMTP_USER'));

    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });
});
