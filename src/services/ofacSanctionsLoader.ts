import { createHash, verify } from 'crypto';
import { globalMetrics } from '../lib/metrics';

export const OFAC_SIGNATURE_FAILED_METRIC = 'sanctions.source.signature_failed';
export const OFAC_HASH_MISMATCH_METRIC = 'sanctions.source.hash_mismatch';

export class OfacSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfacSignatureError';
    Object.setPrototypeOf(this, OfacSignatureError.prototype);
  }
}

export class OfacFetchError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'OfacFetchError';
    Object.setPrototypeOf(this, OfacFetchError.prototype);
  }
}

export class OfacParseError extends Error {
  constructor(message: string, public readonly line?: number) {
    super(message);
    this.name = 'OfacParseError';
    Object.setPrototypeOf(this, OfacParseError.prototype);
  }
}

export class OfacHashMismatchError extends Error {
  constructor(version: string, expected: string, actual: string) {
    super(`Parse hash mismatch for version ${version}: expected ${expected}, got ${actual}`);
    this.name = 'OfacHashMismatchError';
    Object.setPrototypeOf(this, OfacHashMismatchError.prototype);
  }
}

export interface OfacAddress {
  line1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface OfacEntry {
  uid: string;
  name: string;
  sdnType: string;
  programs: string[];
  title?: string;
  remarks?: string;
  addresses: OfacAddress[];
}

export interface OfacSanctionsResult {
  version: string;
  entries: OfacEntry[];
  parseHash: string;
  fetchedAt: Date;
  signatureValid: boolean;
  hashValid: boolean;
}

export interface OfacLoaderConfig {
  trustAnchorBase64: string;
  pinnedHashes: Record<string, string>;
  listUrl: string;
  sigUrl: string;
  fetchTimeoutMs: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30000;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export class OfacSanctionsLoader {
  private config: OfacLoaderConfig;

  constructor(config: Partial<OfacLoaderConfig> = {}) {
    this.config = {
      trustAnchorBase64: config.trustAnchorBase64 ?? '',
      pinnedHashes: config.pinnedHashes ?? {},
      listUrl: config.listUrl ?? '',
      sigUrl: config.sigUrl ?? '',
      fetchTimeoutMs: config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    };
  }

  setConfig(config: Partial<OfacLoaderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): Readonly<OfacLoaderConfig> {
    return { ...this.config };
  }

  async fetchWithTimeout(url: string, timeoutMs: number): Promise<{ data: string; buffer: Buffer }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new OfacFetchError(
          `HTTP ${response.status} fetching ${url}`,
          response.status,
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { data: buffer.toString('utf-8'), buffer };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchSignedList(): Promise<{ listData: string; signature: Buffer }> {
    const [listResult, sigResult] = await Promise.all([
      this.fetchWithTimeout(this.config.listUrl, this.config.fetchTimeoutMs),
      this.fetchWithTimeout(this.config.sigUrl, this.config.fetchTimeoutMs),
    ]);
    const signature = Buffer.from(sigResult.data.trim(), 'hex');
    if (signature.length !== 64) {
      throw new OfacSignatureError(
        `Invalid signature length: expected 64 bytes, got ${signature.length}`,
      );
    }
    return { listData: listResult.data, signature };
  }

  verifySignature(payload: string, signature: Buffer, publicKeyBase64: string): boolean {
    try {
      const spkiDer = Buffer.from(publicKeyBase64, 'base64');
      const payloadBuffer = Buffer.from(payload, 'utf-8');
      return verify(null, payloadBuffer, { key: spkiDer, format: 'der', type: 'spki' }, signature);
    } catch (err) {
      throw new OfacSignatureError(`Signature verification error: ${String(err)}`);
    }
  }

  parseCsv(csvData: string): OfacEntry[] {
    const cleaned = csvData.replace(/^\ufeff/, '');
    const lines = cleaned.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      throw new OfacParseError('CSV must contain a header line and at least one data row');
    }
    const header = parseCsvLine(lines[0]);
    const colIndex: Record<string, number> = {};
    for (let i = 0; i < header.length; i++) {
      colIndex[header[i].replace(/^"(.*)"$/, '$1').toLowerCase()] = i;
    }
    const required = ['ent_num', 'sdn_name'];
    for (const col of required) {
      if (!(col in colIndex)) {
        throw new OfacParseError(`Missing required column: ${col}`);
      }
    }
    const entries: OfacEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const fields = parseCsvLine(lines[i]);
        const getField = (name: string): string | undefined => {
          const idx = colIndex[name];
          return idx !== undefined && idx < fields.length
            ? fields[idx].replace(/^"(.*)"$/, '$1')
            : undefined;
        };
        const uid = getField('ent_num') || '';
        const name = getField('sdn_name') || '';
        if (!uid && !name) continue;
        const programsRaw = getField('program') || '';
        const addresses: OfacAddress[] = [];
        const hasAddressColumns = 'address' in colIndex || 'city' in colIndex || 'country' in colIndex;
        if (hasAddressColumns) {
          addresses.push({
            line1: getField('address'),
            city: getField('city'),
            state: getField('state/province'),
            zip: getField('zip/postal code'),
            country: getField('country'),
          });
        }
        entries.push({
          uid,
          name,
          sdnType: getField('sdn_type') || '',
          programs: programsRaw.split(';').map(s => s.trim()).filter(Boolean),
          title: getField('title'),
          remarks: getField('remarks'),
          addresses,
        });
      } catch { /* istanbul ignore next -- defense-in-depth, parseCsvLine is safe */
        throw new OfacParseError(`Failed to parse row ${i + 1}`, i + 1);
      }
    }
    return entries;
  }

  computeParseHash(entries: OfacEntry[]): string {
    const normalized = entries.map(e => ({
      uid: e.uid,
      name: e.name,
      sdnType: e.sdnType,
      programs: [...e.programs].sort(),
      title: e.title ?? null,
      remarks: e.remarks ?? null,
      addresses: e.addresses.map(a => ({
        line1: a.line1 ?? /* istanbul ignore next */ null,
        city: a.city ?? /* istanbul ignore next */ null,
        state: a.state ?? /* istanbul ignore next */ null,
        zip: a.zip ?? /* istanbul ignore next */ null,
        country: a.country ?? /* istanbul ignore next */ null,
      })),
    }));
    const keys = normalized.length > 0
      ? Object.keys(normalized[0]).sort()
      : ['uid', 'name', 'sdnType', 'programs', 'title', 'remarks', 'addresses'];
    const json = JSON.stringify(normalized, keys);
    return createHash('sha256').update(json).digest('hex');
  }

  verifyParseHash(version: string, actualHash: string): boolean {
    const expected = this.config.pinnedHashes[version];
    if (!expected) return true;
    if (actualHash !== expected) {
      globalMetrics.incrementCounter(
        OFAC_HASH_MISMATCH_METRIC,
        { version },
        1,
        'Parse output hash mismatch detected for OFAC version',
      );
      return false;
    }
    return true;
  }

  async loadSanctions(version: string): Promise<OfacSanctionsResult> {
    const fetchedAt = new Date();
    const { listData, signature } = await this.fetchSignedList();
    const trustAnchor = this.config.trustAnchorBase64;
    let signatureValid = false;
    try {
      signatureValid = this.verifySignature(listData, signature, trustAnchor);
    } catch (err) {
      signatureValid = false;
    }
    if (!signatureValid) {
      globalMetrics.incrementCounter(
        OFAC_SIGNATURE_FAILED_METRIC,
        { version },
        1,
        'OFAC list signature verification failed',
      );
      throw new OfacSignatureError(
        `Signature verification failed for OFAC list version ${version}`,
      );
    }
    const entries = this.parseCsv(listData);
    const parseHash = this.computeParseHash(entries);
    const hashValid = this.verifyParseHash(version, parseHash);
    return {
      version,
      entries,
      parseHash,
      fetchedAt,
      signatureValid,
      hashValid,
    };
  }
}

export function createOfacSanctionsLoader(
  config?: Partial<OfacLoaderConfig>,
): OfacSanctionsLoader {
  return new OfacSanctionsLoader(config);
}
