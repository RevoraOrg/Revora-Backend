import { env } from './env';

describe('Environment Configuration - ALLOWED_ORIGINS', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should parse a single origin', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const { env: updatedEnv } = require('./env');
    expect(updatedEnv.ALLOWED_ORIGINS).toEqual(['https://app.example.com']);
  });

  it('should parse multiple comma-separated origins', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com, https://admin.example.com ';
    const { env: updatedEnv } = require('./env');
    expect(updatedEnv.ALLOWED_ORIGINS).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('should default to localhost in development', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOWED_ORIGINS;
    const { env: updatedEnv } = require('./env');
    expect(updatedEnv.ALLOWED_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('should return empty array in production if not set', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOWED_ORIGINS;
    // Mocking other required production env vars
    process.env.DATABASE_URL = 'postgres://localhost:5432';
    process.env.JWT_SECRET = 'secret';
    
    const { env: updatedEnv } = require('./env');
    expect(updatedEnv.ALLOWED_ORIGINS).toEqual([]);
  });

  it('should throw error if both "*" and explicit origins are provided', () => {
    process.env.ALLOWED_ORIGINS = '*,https://app.example.com';
    expect(() => require('./env')).toThrow("CORS configuration error: ALLOWED_ORIGINS cannot contain both '*' and explicit origins");
  });

  it('should allow a single "*" origin', () => {
    process.env.ALLOWED_ORIGINS = '*';
    const { env: updatedEnv } = require('./env');
    expect(updatedEnv.ALLOWED_ORIGINS).toEqual(['*']);
  });
});
