import { buildConfig, envBoolean, readEnvBoolean } from './env';

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

  /**
   * Boolean environment flags — issue #1305.
   *
   * Regression context: `z.coerce.boolean()` applies `Boolean(value)`, so
   * `"false"`, `"0"` and `"no"` all parsed as `true`. These tests fail on the
   * pre-fix implementation for every "disabled" input below.
   */
  describe('envBoolean helper', () => {
    const truthyValues = ['true', 'TRUE', '1', 'yes', 'YES', 'on', 'On', ' true ', '\tTRUE\n'];
    const falsyValues = ['false', 'FALSE', '0', 'no', 'NO', 'off', 'OFF', ' false ', ' 0 '];

    it.each(truthyValues)('parses %j as true', (value) => {
      const result = envBoolean(false).safeParse(value);
      expect(result.success).toBe(true);
      expect(result.data).toBe(true);
    });

    it.each(falsyValues)('parses %j as false', (value) => {
      const result = envBoolean(true).safeParse(value);
      expect(result.success).toBe(true);
      expect(result.data).toBe(false);
    });

    it('returns the default when the variable is unset', () => {
      expect(envBoolean(false).parse(undefined)).toBe(false);
      expect(envBoolean(true).parse(undefined)).toBe(true);
    });

    it.each(['maybe', '2', 'y', 'n', 'enabled', 'null', '', '   ', 'falsey', 'offf'])(
      'rejects %j with a clear validation message',
      (value) => {
        const result = envBoolean(false).safeParse(value);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toBe(
          'must be one of: true, false, 1, 0, yes, no, on, off (case-insensitive)',
        );
      },
    );
  });

  describe('boolean feature flags via buildConfig', () => {
    it('parses OUTBOX_DISPATCHER_ENABLED=false as false (regression: coerce returned true)', () => {
      process.env.NODE_ENV = 'test';
      process.env.OUTBOX_DISPATCHER_ENABLED = 'false';

      const cfg = buildConfig();
      expect(cfg.OUTBOX_DISPATCHER_ENABLED).toBe(false);
    });

    it('parses OUTBOX_DISPATCHER_ENABLED=0 as false', () => {
      process.env.NODE_ENV = 'test';
      process.env.OUTBOX_DISPATCHER_ENABLED = '0';

      expect(buildConfig().OUTBOX_DISPATCHER_ENABLED).toBe(false);
    });

    it('parses OUTBOX_DISPATCHER_ENABLED=1 as true', () => {
      process.env.NODE_ENV = 'test';
      process.env.OUTBOX_DISPATCHER_ENABLED = '1';

      expect(buildConfig().OUTBOX_DISPATCHER_ENABLED).toBe(true);
    });

    it('defaults OUTBOX_DISPATCHER_ENABLED to false when unset', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.OUTBOX_DISPATCHER_ENABLED;

      expect(buildConfig().OUTBOX_DISPATCHER_ENABLED).toBe(false);
    });

    it('parses EMAIL_DELIVERABILITY_ENABLED=off as false (previously mounted webhooks anyway)', () => {
      process.env.NODE_ENV = 'test';
      process.env.EMAIL_DELIVERABILITY_ENABLED = 'off';

      expect(buildConfig().EMAIL_DELIVERABILITY_ENABLED).toBe(false);
    });

    it('parses EMAIL_DELIVERABILITY_ENABLED=no as false', () => {
      process.env.NODE_ENV = 'test';
      process.env.EMAIL_DELIVERABILITY_ENABLED = 'no';

      expect(buildConfig().EMAIL_DELIVERABILITY_ENABLED).toBe(false);
    });

    it('defaults EMAIL_DELIVERABILITY_ENABLED to true when unset (default unchanged)', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.EMAIL_DELIVERABILITY_ENABLED;

      expect(buildConfig().EMAIL_DELIVERABILITY_ENABLED).toBe(true);
    });

    it('fails validation with a clear message when a boolean flag is set to "maybe"', () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
        throw new Error(`Process.exit called with ${code}`);
      });
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      process.env.NODE_ENV = 'test';
      process.env.EMAIL_DELIVERABILITY_ENABLED = 'maybe';

      expect(() => buildConfig()).toThrow('Process.exit called with 1');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          'EMAIL_DELIVERABILITY_ENABLED: must be one of: true, false, 1, 0, yes, no, on, off (case-insensitive)',
        ),
      );

      mockExit.mockRestore();
      mockConsoleError.mockRestore();
    });

    it('fails validation when a boolean flag is set to an empty string', () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
        throw new Error(`Process.exit called with ${code}`);
      });
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      process.env.NODE_ENV = 'test';
      process.env.OUTBOX_DISPATCHER_ENABLED = '';

      expect(() => buildConfig()).toThrow('Process.exit called with 1');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('OUTBOX_DISPATCHER_ENABLED: must be one of'),
      );

      mockExit.mockRestore();
      mockConsoleError.mockRestore();
    });
  });

  describe('readEnvBoolean (ad-hoc process.env reads)', () => {
    afterEach(() => {
      delete process.env.TEST_BOOL_FLAG;
    });

    it('reads the shared accepted value set at call time', () => {
      process.env.TEST_BOOL_FLAG = 'yes';
      expect(readEnvBoolean('TEST_BOOL_FLAG', false)).toBe(true);

      process.env.TEST_BOOL_FLAG = '0';
      expect(readEnvBoolean('TEST_BOOL_FLAG', true)).toBe(false);
    });

    it('returns the default when the variable is unset', () => {
      delete process.env.TEST_BOOL_FLAG;
      expect(readEnvBoolean('TEST_BOOL_FLAG', false)).toBe(false);
      expect(readEnvBoolean('TEST_BOOL_FLAG', true)).toBe(true);
    });

    it('throws a clear error naming the variable for invalid values', () => {
      process.env.TEST_BOOL_FLAG = 'maybe';
      expect(() => readEnvBoolean('TEST_BOOL_FLAG', false)).toThrow(
        'TEST_BOOL_FLAG must be one of: true, false, 1, 0, yes, no, on, off (case-insensitive)',
      );
    });
  });
});
