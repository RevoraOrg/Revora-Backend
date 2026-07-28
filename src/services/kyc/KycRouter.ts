import crypto from 'crypto';
import { KycProvider } from './KycProvider';

export interface RouteTableEntry {
  jurisdiction: string; // ISO 3166-1 alpha-2 e.g. 'US', 'EU'
  providerName: string;
}

export interface RouteTable {
  version: string;
  entries: RouteTableEntry[];
  signature: string; // HMAC of version + entries using a secret key
}

export class KycRouter {
  private providers: Map<string, KycProvider> = new Map();
  private routeMap: Map<string, string> = new Map();
  private currentVersion: string = '';

  constructor(private readonly secretKey: string) {}

  /**
   * Registers a provider strategy.
   */
  registerProvider(provider: KycProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Loads a signed and versioned route table.
   * Throws an error if the signature is invalid to ensure security.
   */
  loadRouteTable(table: RouteTable): void {
    const payload = JSON.stringify({ version: table.version, entries: table.entries });
    const expectedSignature = crypto
      .createHmac('sha256', this.secretKey)
      .update(payload)
      .digest('hex');

    if (table.signature !== expectedSignature) {
      throw new Error('Invalid route table signature. Fails closed.');
    }

    this.routeMap.clear();
    for (const entry of table.entries) {
      this.routeMap.set(entry.jurisdiction, entry.providerName);
    }
    this.currentVersion = table.version;
  }

  /**
   * Routes an applicant to the correct KYC provider based on their jurisdiction.
   * "Unknown country fails closed" per requirements.
   */
  route(jurisdiction: string): KycProvider {
    const providerName = this.routeMap.get(jurisdiction);
    if (!providerName) {
      throw new Error(`Jurisdiction ${jurisdiction} not supported. Fails closed.`);
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Configured provider ${providerName} not registered.`);
    }

    return provider;
  }

  getVersion(): string {
    return this.currentVersion;
  }
}
