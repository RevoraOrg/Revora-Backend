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
});
