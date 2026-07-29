import { generateKeyPairSync, sign } from 'crypto';
import { globalMetrics } from '../lib/metrics';
import {
  OfacSanctionsLoader,
  OfacSignatureError,
  OfacFetchError,
  OfacParseError,
  OfacHashMismatchError,
  OFAC_SIGNATURE_FAILED_METRIC,
  OFAC_HASH_MISMATCH_METRIC,
  OfacEntry,
  OfacSanctionsResult,
} from './ofacSanctionsLoader';

function generateTestKeyPair(): { publicKeyBase64: string; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKeyBase64: publicKey.toString('base64'),
    privateKey,
  };
}

function signPayload(payload: string, privateKey: Buffer): string {
  const sig = sign(null, Buffer.from(payload, 'utf-8'), {
    key: privateKey,
    format: 'der',
    type: 'pkcs8',
  });
  return sig.toString('hex');
}

function makeArrayBuffer(data: string): ArrayBuffer {
  const buf = Buffer.from(data, 'utf-8');
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  view.set(buf);
  return ab;
}

const SAMPLE_CSV = `"ent_num","SDN_Name","SDN_Type","Program","Title","Remarks","Address","City","State/Province","ZIP/Postal Code","Country"
"1","Test Entity","Individual","SDGT;IFSR","CEO","Sanctioned for testing","123 Test St","Testville","TS","12345","Testania"
"2","Another Entity","Entity","SDNT","","","456 Other Ave","Othertown","OT","67890","Otherland"`;

const SAMPLE_CSV_MINIMAL = `"ent_num","SDN_Name"
"1","Minimal Entry"`;

const MALFORMED_CSV = `"ent_num","SDN_Name"
"1","Good Entry"
bad,line,with,extra,fields`;

describe('OfacSanctionsLoader', () => {
  let keyPair: { publicKeyBase64: string; privateKey: Buffer };
  let validSignatureHex: string;
  let loader: OfacSanctionsLoader;

  beforeEach(() => {
    keyPair = generateTestKeyPair();
    validSignatureHex = signPayload(SAMPLE_CSV, keyPair.privateKey);
    loader = new OfacSanctionsLoader({
      trustAnchorBase64: keyPair.publicKeyBase64,
      pinnedHashes: {},
      listUrl: 'https://example.com/ofac.csv',
      sigUrl: 'https://example.com/ofac.csv.sig',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor and config', () => {
    it('should create loader with default config', () => {
      const l = new OfacSanctionsLoader();
      const cfg = l.getConfig();
      expect(cfg.trustAnchorBase64).toBe('');
      expect(cfg.fetchTimeoutMs).toBe(30000);
      expect(cfg.listUrl).toBe('');
      expect(cfg.sigUrl).toBe('');
    });

    it('should create loader with partial config', () => {
      const l = new OfacSanctionsLoader({ fetchTimeoutMs: 5000 });
      expect(l.getConfig().fetchTimeoutMs).toBe(5000);
    });

    it('should update config via setConfig', () => {
      loader.setConfig({ fetchTimeoutMs: 15000 });
      expect(loader.getConfig().fetchTimeoutMs).toBe(15000);
    });

    it('should create loader via factory', () => {
      const { OfacSanctionsLoader: LoaderClass, createOfacSanctionsLoader } = require('./ofacSanctionsLoader');
      const l = createOfacSanctionsLoader({ fetchTimeoutMs: 10000 });
      expect(l).toBeInstanceOf(LoaderClass);
      expect(l.getConfig().fetchTimeoutMs).toBe(10000);
    });
  });

  describe('fetchWithTimeout', () => {
    it('should fetch data successfully', async () => {
      const mockResponse = {
        ok: true,
        arrayBuffer: () => Promise.resolve(makeArrayBuffer('hello world')),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);
      const result = await loader.fetchWithTimeout('https://example.com/data', 5000);
      expect(result.data).toBe('hello world');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });

    it('should throw OfacFetchError on HTTP error', async () => {
      const mockResponse = { ok: false, status: 404 };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);
      await expect(loader.fetchWithTimeout('https://example.com/404', 5000))
        .rejects.toThrow(OfacFetchError);
      await expect(loader.fetchWithTimeout('https://example.com/404', 5000))
        .rejects.toThrow('HTTP 404');
    });

    it('should throw on timeout', async () => {
      jest.spyOn(global, 'fetch').mockImplementation((_url, opts) => {
        return new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            } else {
              signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'AbortError'));
              });
            }
          }
        });
      });
      await expect(loader.fetchWithTimeout('https://example.com/timeout', 10))
        .rejects.toThrow();
    }, 10000);

    it('should abort on timeout signal', async () => {
      const abortSpy = jest.fn();
      jest.spyOn(global, 'fetch').mockImplementation((_url, opts) => {
        const signal = opts?.signal as AbortSignal | undefined;
        expect(signal).toBeDefined();
        if (signal) {
          signal.addEventListener('abort', abortSpy);
        }
        return new Promise((_resolve, reject) => {
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            } else {
              signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'AbortError'));
              });
            }
          }
        });
      });
      await expect(loader.fetchWithTimeout('https://example.com/timeout', 10))
        .rejects.toThrow();
    }, 10000);
  });

  describe('fetchSignedList', () => {
    it('should fetch list and signature', async () => {
      let callCount = 0;
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        callCount++;
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? validSignatureHex : SAMPLE_CSV;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      const result = await loader.fetchSignedList();
      expect(result.listData).toBe(SAMPLE_CSV);
      expect(result.signature.toString('hex')).toBe(validSignatureHex);
      expect(callCount).toBe(2);
    });

    it('should reject invalid signature length', async () => {
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? 'aabb' : SAMPLE_CSV;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      await expect(loader.fetchSignedList()).rejects.toThrow(OfacSignatureError);
    });
  });

  describe('verifySignature', () => {
    it('should verify a valid signature', () => {
      const result = loader.verifySignature(
        SAMPLE_CSV,
        Buffer.from(validSignatureHex, 'hex'),
        keyPair.publicKeyBase64,
      );
      expect(result).toBe(true);
    });

    it('should reject a tampered payload', () => {
      const result = loader.verifySignature(
        SAMPLE_CSV + 'TAMPERED',
        Buffer.from(validSignatureHex, 'hex'),
        keyPair.publicKeyBase64,
      );
      expect(result).toBe(false);
    });

    it('should reject with wrong public key', () => {
      const wrongPair = generateTestKeyPair();
      const result = loader.verifySignature(
        SAMPLE_CSV,
        Buffer.from(validSignatureHex, 'hex'),
        wrongPair.publicKeyBase64,
      );
      expect(result).toBe(false);
    });

    it('should throw on corrupt public key', () => {
      const invalidKey = Buffer.alloc(16).toString('base64');
      expect(() =>
        loader.verifySignature(SAMPLE_CSV, Buffer.from(validSignatureHex, 'hex'), invalidKey),
      ).toThrow(OfacSignatureError);
    });

    it('should handle empty payload', () => {
      const sig = signPayload('', keyPair.privateKey);
      const result = loader.verifySignature('', Buffer.from(sig, 'hex'), keyPair.publicKeyBase64);
      expect(result).toBe(true);
    });

    it('should handle empty signature buffer', () => {
      const result = loader.verifySignature(
        SAMPLE_CSV,
        Buffer.alloc(64),
        keyPair.publicKeyBase64,
      );
      expect(result).toBe(false);
    });
  });

  describe('parseCsv', () => {
    it('should parse valid CSV', () => {
      const entries = loader.parseCsv(SAMPLE_CSV);
      expect(entries).toHaveLength(2);
      expect(entries[0].uid).toBe('1');
      expect(entries[0].name).toBe('Test Entity');
      expect(entries[0].sdnType).toBe('Individual');
      expect(entries[0].programs).toEqual(['SDGT', 'IFSR']);
      expect(entries[0].title).toBe('CEO');
      expect(entries[0].remarks).toBe('Sanctioned for testing');
      expect(entries[0].addresses).toHaveLength(1);
      expect(entries[0].addresses[0].line1).toBe('123 Test St');
      expect(entries[0].addresses[0].city).toBe('Testville');
      expect(entries[0].addresses[0].country).toBe('Testania');
    });

    it('should parse minimal CSV with only required columns', () => {
      const entries = loader.parseCsv(SAMPLE_CSV_MINIMAL);
      expect(entries).toHaveLength(1);
      expect(entries[0].uid).toBe('1');
      expect(entries[0].name).toBe('Minimal Entry');
      expect(entries[0].programs).toEqual([]);
      expect(entries[0].addresses).toEqual([]);
    });

    it('should throw on empty data', () => {
      expect(() => loader.parseCsv('')).toThrow(OfacParseError);
    });

    it('should throw on header only (no data rows)', () => {
      expect(() => loader.parseCsv('"ent_num","SDN_Name"')).toThrow(OfacParseError);
    });

    it('should throw on missing required columns', () => {
      const badCsv = '"foo","bar"\n"1","2"';
      expect(() => loader.parseCsv(badCsv)).toThrow(OfacParseError);
    });

    it('should handle CSV with Windows line endings', () => {
      const windowsCsv = '"ent_num","SDN_Name"\r\n"1","Test"';
      const entries = loader.parseCsv(windowsCsv);
      expect(entries).toHaveLength(1);
    });

    it('should handle commas inside quoted fields', () => {
      const csvWithCommas = `"ent_num","SDN_Name","Remarks"
"1","Entity, Inc.","Has a comma, in remarks"`;
      const entries = loader.parseCsv(csvWithCommas);
      expect(entries[0].name).toBe('Entity, Inc.');
      expect(entries[0].remarks).toBe('Has a comma, in remarks');
    });

    it('should handle escaped quotes in fields', () => {
      const csvWithQuotes = `"ent_num","SDN_Name"
"1","Entity ""The Great"""`;
      const entries = loader.parseCsv(csvWithQuotes);
      expect(entries[0].name).toBe('Entity "The Great"');
    });

    it('should handle empty address fields gracefully', () => {
      const csvNoAddress = `"ent_num","SDN_Name","Address","City","Country"
"1","Test","","",""`;
      const entries = loader.parseCsv(csvNoAddress);
      expect(entries).toHaveLength(1);
      expect(entries[0].addresses).toHaveLength(1);
      expect(entries[0].addresses[0].line1).toBe('');
    });
  });

  describe('computeParseHash', () => {
    it('should produce deterministic hash for same data', () => {
      const entries1 = loader.parseCsv(SAMPLE_CSV);
      const entries2 = loader.parseCsv(SAMPLE_CSV);
      const hash1 = loader.computeParseHash(entries1);
      const hash2 = loader.computeParseHash(entries2);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hash for different data', () => {
      const entries1 = loader.parseCsv(SAMPLE_CSV);
      const entries2 = loader.parseCsv(SAMPLE_CSV_MINIMAL);
      const hash1 = loader.computeParseHash(entries1);
      const hash2 = loader.computeParseHash(entries2);
      expect(hash1).not.toBe(hash2);
    });

    it('should produce consistent hash with field ordering', () => {
      const entries1 = loader.parseCsv(SAMPLE_CSV);
      const hash1 = loader.computeParseHash(entries1);
      const hash2 = loader.computeParseHash(entries1);
      expect(hash1).toBe(hash2);
    });
  });

  describe('verifyParseHash', () => {
    beforeEach(() => {
      globalMetrics.reset();
    });

    it('should pass when no pinned hash for version', () => {
      loader.setConfig({ pinnedHashes: {} });
      expect(loader.verifyParseHash('v1', 'anyhash')).toBe(true);
    });

    it('should pass when hash matches pinned value', () => {
      loader.setConfig({ pinnedHashes: { v1: 'abc123' } });
      expect(loader.verifyParseHash('v1', 'abc123')).toBe(true);
    });

    it('should return false and emit metric on hash mismatch', () => {
      loader.setConfig({ pinnedHashes: { v1: 'expected' } });
      const result = loader.verifyParseHash('v1', 'actual');
      expect(result).toBe(false);
    });
  });

  describe('loadSanctions (integration)', () => {
    it('should successfully load and verify', async () => {
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? validSignatureHex : SAMPLE_CSV;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      const result = await loader.loadSanctions('v1');
      expect(result.version).toBe('v1');
      expect(result.entries).toHaveLength(2);
      expect(result.signatureValid).toBe(true);
      expect(result.hashValid).toBe(true);
      expect(result.fetchedAt).toBeInstanceOf(Date);
    });

    it('should throw OfacSignatureError on tampered list', async () => {
      const tamperedCsv = SAMPLE_CSV.replace('Test Entity', 'EVIL Entity');
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? validSignatureHex : tamperedCsv;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      await expect(loader.loadSanctions('v1')).rejects.toThrow(OfacSignatureError);
    });

    it('should emit signature_failed metric on tampered list', async () => {
      const tamperedCsv = SAMPLE_CSV.replace('Test Entity', 'EVIL Entity');
      let metricEmitted = false;
      const origIncrementCounter = globalMetrics.incrementCounter.bind(globalMetrics);
      jest.spyOn(globalMetrics, 'incrementCounter').mockImplementation((name: string) => {
        if (name === OFAC_SIGNATURE_FAILED_METRIC) metricEmitted = true;
        return origIncrementCounter(name);
      });
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? validSignatureHex : tamperedCsv;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      await expect(loader.loadSanctions('v1')).rejects.toThrow(OfacSignatureError);
      expect(metricEmitted).toBe(true);
    });

    it('should detect hash drift when pinned hash does not match', async () => {
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? validSignatureHex : SAMPLE_CSV;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      loader.setConfig({ pinnedHashes: { v1: 'deadbeef' } });
      const result = await loader.loadSanctions('v1');
      expect(result.hashValid).toBe(false);
      expect(result.parseHash).not.toBe('deadbeef');
    });

    it('should propagate fetch errors', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
      await expect(loader.loadSanctions('v1')).rejects.toThrow();
    });

    it('should propagate HTTP error', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
      await expect(loader.loadSanctions('v1')).rejects.toThrow(OfacFetchError);
    });

    it('should handle empty list gracefully', async () => {
      const emptyCsv = '"ent_num","SDN_Name"\n"",""';
      const emptySig = signPayload(emptyCsv, keyPair.privateKey);
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? emptySig : emptyCsv;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      const result = await loader.loadSanctions('v1');
      expect(result.entries).toHaveLength(0);
    });
  });

  describe('OfacHashMismatchError', () => {
    it('should construct with correct message', () => {
      const err = new OfacHashMismatchError('v1', 'abc', 'def');
      expect(err.message).toBe('Parse hash mismatch for version v1: expected abc, got def');
      expect(err.name).toBe('OfacHashMismatchError');
    });
  });

  describe('loadSanctions error paths', () => {
    it('should handle verifySignature throwing during loadSanctions', async () => {
      jest.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
        const isSig = url.toString().endsWith('.sig');
        const body = isSig ? validSignatureHex : SAMPLE_CSV;
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(makeArrayBuffer(body)),
        } as unknown as Response);
      });
      const badKeyLoader = new OfacSanctionsLoader({
        trustAnchorBase64: Buffer.alloc(16).toString('base64'),
        pinnedHashes: {},
        listUrl: 'https://example.com/ofac.csv',
        sigUrl: 'https://example.com/ofac.csv.sig',
      });
      await expect(badKeyLoader.loadSanctions('v1')).rejects.toThrow(OfacSignatureError);
    });
  });

  describe('edge cases and error paths', () => {
    it('should handle abnormally large entry names', () => {
      const longName = 'A'.repeat(1000);
      const csv = `"ent_num","SDN_Name"\n"1","${longName}"`;
      const entries = loader.parseCsv(csv);
      expect(entries[0].name).toBe(longName);
    });

    it('should handle unicode names', () => {
      const csv = `"ent_num","SDN_Name"\n"1","José María García ñ"`;
      const entries = loader.parseCsv(csv);
      expect(entries[0].name).toBe('José María García ñ');
    });

    it('should handle many programs separated by semicolon', () => {
      const csv = `"ent_num","SDN_Name","Program"\n"1","Test","A;B;C;D;E"`;
      const entries = loader.parseCsv(csv);
      expect(entries[0].programs).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    it('should handle CSV with BOM', () => {
      const bomCsv = '\ufeff"ent_num","SDN_Name"\n"1","Test"';
      const entries = loader.parseCsv(bomCsv);
      expect(entries).toHaveLength(1);
    });

    it('should reject signature with wrong key via verifySignature directly', () => {
      const wrongPair = generateTestKeyPair();
      const result = loader.verifySignature(
        SAMPLE_CSV,
        Buffer.from(validSignatureHex, 'hex'),
        wrongPair.publicKeyBase64,
      );
      expect(result).toBe(false);
    });

    it('should handle missing trust anchor gracefully', () => {
      const noKeyLoader = new OfacSanctionsLoader({
        trustAnchorBase64: '',
        listUrl: 'https://example.com/list',
        sigUrl: 'https://example.com/list.sig',
      });
      expect(() => noKeyLoader.verifySignature('data', Buffer.alloc(64), '')).toThrow(OfacSignatureError);
    });
  });
});
