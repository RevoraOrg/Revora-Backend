import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');

describe('Dockerfile', () => {
  it('uses the same Node 22 Alpine image in both stages', () => {
    expect(dockerfile.match(/^FROM node:\S+/gm)).toEqual([
      'FROM node:22-alpine AS builder',
      'FROM node:22-alpine',
    ]);
  });

  it('installs only production dependencies with the current npm flag', () => {
    expect(dockerfile).toContain('RUN npm ci --omit=dev');
  });

  it('runs as the non-root node user with the application directory owned by it', () => {
    const chownIndex = dockerfile.indexOf('RUN chown -R node:node /app');
    const userIndex = dockerfile.indexOf('USER node');

    expect(chownIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThan(chownIndex);
  });

  it('keeps the health check on the exposed application port', () => {
    expect(dockerfile).toMatch(/^ENV PORT=3000$/m);
    expect(dockerfile).toMatch(/^EXPOSE 3000$/m);
    expect(dockerfile).toContain('http://localhost:3000/health');
  });
});
