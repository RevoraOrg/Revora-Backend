import * as fs from 'fs';
import * as path from 'path';

import {
  createRecorder,
  type RecordedInteraction,
  type RecordedRequest,
  type RecordedResponse,
} from './recorder';

const FIXTURE_DIR = path.join(__dirname, '__tmp_recorder_fixture__');

describe('Recorded request fixtures', () => {
  afterEach(async () => {
    await fs.promises.rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => undefined);
  });

  it('exposes the RecordedRequest, RecordedResponse, and RecordedInteraction contract with valid values', () => {
    const request: RecordedRequest = {
      method: 'POST',
      path: '/aml/kyc/check',
      headers: {
        authorization: 'Bearer test-token',
        'x-request-id': 'req-123',
      },
      body: {
        email: 'user@example.com',
        ssn: '123-45-6789',
      },
      timestamp: '2026-09-27T00:00:00.000Z',
    };

    const response: RecordedResponse = {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        status: 'verified',
      },
      timestamp: '2026-09-27T00:00:00.100Z',
    };

    const interaction: RecordedInteraction = {
      request,
      response,
      label: 'kyc_check_success',
    };

    expect(interaction.label).toBe('kyc_check_success');
    expect(interaction.request.method).toBe('POST');
    expect(interaction.request.path).toBe('/aml/kyc/check');
    expect(interaction.response.status).toBe(200);
    expect(interaction.response.body).toEqual({ status: 'verified' });
  });

  it('tracks the request/response lifecycle from empty to recorded and flushed', async () => {
    const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'sumsub' });

    expect(recorder.getCount()).toBe(0);

    recorder.record(
      'kyc_check_success',
      { method: 'POST', path: '/kyc', headers: { authorization: 'Bearer token-1' }, body: { email: 'alice@example.com' } },
      { status: 200, headers: { 'content-type': 'application/json' }, body: { status: 'verified' } },
    );
    expect(recorder.getCount()).toBe(1);

    recorder.record(
      'kyc_check_failure',
      { method: 'POST', path: '/kyc', headers: { authorization: 'Bearer token-2' }, body: { email: 'bob@example.com' } },
      { status: 400, headers: { 'content-type': 'application/json' }, body: { error: 'invalid document' } },
    );
    expect(recorder.getCount()).toBe(2);

    const filePath = await recorder.flush();
    const fixture = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));

    expect(filePath).toBe(path.join(FIXTURE_DIR, 'sumsub.fixtures.json'));
    expect(fixture.provider).toBe('sumsub');
    expect(fixture.version).toBe(1);
    expect(fixture.interactions).toHaveLength(2);
    expect(fixture.interactions.map((item: { label: string }) => item.label)).toEqual([
      'kyc_check_success',
      'kyc_check_failure',
    ]);
  });

  it('rejects representative invalid request and response inputs deterministically', () => {
    expect(() => createRecorder({ fixtureDir: '', provider: 'test' })).toThrow(TypeError);

    const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'test' });

    expect(() =>
      recorder.record(
        '',
        { method: 'GET', path: '/health', headers: {} },
        { status: 200, headers: {}, body: { ok: true } },
      ),
    ).toThrow(TypeError);

    expect(() =>
      recorder.record(
        'bad-method',
        { method: '', path: '/health', headers: {} },
        { status: 200, headers: {}, body: { ok: true } },
      ),
    ).toThrow(TypeError);

    expect(() =>
      recorder.record(
        'bad-path',
        { method: 'GET', path: 'health', headers: {} },
        { status: 200, headers: {}, body: { ok: true } },
      ),
    ).toThrow(TypeError);

    expect(() =>
      recorder.record(
        'bad-status',
        { method: 'GET', path: '/health', headers: {} },
        { status: 99, headers: {}, body: { ok: true } },
      ),
    ).toThrow(TypeError);

    expect(() =>
      recorder.record(
        'bad-headers',
        { method: 'GET', path: '/health', headers: {} },
        { status: 200, headers: { authorization: 123 as unknown as string }, body: { ok: true } },
      ),
    ).toThrow(TypeError);
  });

  it('redacts PII deterministically without mutating the original request and response payloads', async () => {
    const originalRequest = {
      method: 'POST',
      path: '/kyc',
      headers: { authorization: 'Bearer secret-token' },
      body: { email: 'alice@example.com', ssn: '123-45-6789' },
    };

    const originalResponse = {
      status: 200,
      headers: { 'set-cookie': 'session=abc123' },
      body: { verification: { email: 'alice@example.com', status: 'approved' } },
    };

    const recorder = createRecorder({ fixtureDir: FIXTURE_DIR, provider: 'jumio' });
    recorder.record('pii_redaction', originalRequest, originalResponse);
    await recorder.flush();

    const fixture = JSON.parse(
      await fs.promises.readFile(path.join(FIXTURE_DIR, 'jumio.fixtures.json'), 'utf-8'),
    );

    expect(originalRequest.body).toEqual({ email: 'alice@example.com', ssn: '123-45-6789' });
    expect(originalResponse.body).toEqual({ verification: { email: 'alice@example.com', status: 'approved' } });
    expect(fixture.interactions[0].request.body.email).not.toBe('alice@example.com');
    expect(fixture.interactions[0].request.body.ssn).not.toBe('123-45-6789');
    expect(fixture.interactions[0].response.body.verification.email).not.toBe('alice@example.com');
    expect(fixture.redaction.totalRedactions).toBeGreaterThan(0);
  });
});
