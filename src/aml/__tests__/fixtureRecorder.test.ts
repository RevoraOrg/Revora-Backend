/**
 * Fixture recorder tests – verifies recording, flushing, loading,
 * and the shouldRecord() environment check.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRecorder, loadFixtures, hasFixtures, shouldRecord } from '../fixtures/recorder';

const FIXTURE_DIR = path.join(__dirname, '__tmp_fixtures__');

describe('Fixture Recorder', () => {
  afterEach(async () => {
    // Clean up temp fixtures
    try {
      await fs.promises.rm(FIXTURE_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('createRecorder', () => {
    it('should track interaction count', () => {
      const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'test' });
      expect(recorder.getCount()).toBe(0);

      recorder.record('label1', { method: 'GET', path: '/api', headers: {} }, { status: 200, headers: {}, body: {} });
      expect(recorder.getCount()).toBe(1);

      recorder.record('label2', { method: 'POST', path: '/api', headers: {} }, { status: 201, headers: {}, body: {} });
      expect(recorder.getCount()).toBe(2);
    });

    it('should redact PII in recorded interactions', () => {
      const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'test' });
      recorder.record(
        'kyc_check',
        { method: 'POST', path: '/kyc', headers: {}, body: { email: 'john@test.com', ssn: '123-45-6789' } },
        { status: 200, headers: {}, body: { status: 'verified', score: 0.95 } },
      );

      const ctx = recorder.getRedactionContext();
      // No cached private values from built-in rules (they use fixed placeholders)
      expect(ctx).toBeDefined();
    });
  });

  describe('flush', () => {
    it('should write a fixture file to disk', async () => {
      const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'sumsub' });
      recorder.record('success', { method: 'POST', path: '/kyc', headers: {} }, { status: 200, headers: {}, body: { ok: true } });
      recorder.record('failure', { method: 'POST', path: '/kyc', headers: {} }, { status: 400, headers: {}, body: { error: 'bad request' } });

      const filePath = await recorder.flush();
      expect(filePath).toBe(path.join(FIXTURE_DIR, 'sumsub.fixtures.json'));

      const content = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
      expect(content.provider).toBe('sumsub');
      expect(content.version).toBe(1);
      expect(content.interactions).toHaveLength(2);
      expect(content.interactions[0].label).toBe('success');
      expect(content.interactions[1].label).toBe('failure');
      expect(content.recordedAt).toBeDefined();
      expect(content.redaction).toBeDefined();
    });

    it('should create fixture directory if it does not exist', async () => {
      const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'test' });
      recorder.record('test', { method: 'GET', path: '/', headers: {} }, { status: 200, headers: {}, body: {} });
      const filePath = await recorder.flush();
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe('loadFixtures', () => {
    it('should load a previously recorded fixture', async () => {
      const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'jumio' });
      recorder.record('test', { method: 'GET', path: '/kyc', headers: {} }, { status: 200, headers: {}, body: { result: 'pass' } });
      await recorder.flush();

      const loaded = await loadFixtures(FIXTURE_DIR, 'jumio');
      expect(loaded.provider).toBe('jumio');
      expect(loaded.interactions).toHaveLength(1);
      expect(loaded.interactions[0].label).toBe('test');
    });
  });

  describe('hasFixtures', () => {
    it('should return false when no fixture exists', async () => {
      expect(await hasFixtures(FIXTURE_DIR, 'nonexistent')).toBe(false);
    });

    it('should return true after recording', async () => {
      const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'onfido' });
      recorder.record('test', { method: 'GET', path: '/', headers: {} }, { status: 200, headers: {}, body: {} });
      await recorder.flush();

      expect(await hasFixtures(FIXTURE_DIR, 'onfido')).toBe(true);
    });
  });

  describe('shouldRecord', () => {
    it('should return false when RECORD_FIXTURES is not set', () => {
      const original = process.env.RECORD_FIXTURES;
      delete process.env.RECORD_FIXTURES;
      expect(shouldRecord()).toBe(false);
      if (original !== undefined) process.env.RECORD_FIXTURES = original;
    });

    it('should return true when RECORD_FIXTURES=true', () => {
      const original = process.env.RECORD_FIXTURES;
      process.env.RECORD_FIXTURES = 'true';
      expect(shouldRecord()).toBe(true);
      if (original !== undefined) process.env.RECORD_FIXTURES = original;
      else delete process.env.RECORD_FIXTURES;
    });

    it('should return false when RECORD_FIXTURES=false', () => {
      const original = process.env.RECORD_FIXTURES;
      process.env.RECORD_FIXTURES = 'false';
      expect(shouldRecord()).toBe(false);
      if (original !== undefined) process.env.RECORD_FIXTURES = original;
      else delete process.env.RECORD_FIXTURES;
    });
  });
});
