// Horizon Fake with programmable failure profiles
import { EventEmitter } from 'events';

export interface FailureProfile {
  latencyMs?: number;
  dropConnection?: boolean;
  partialReads?: boolean;
  reorgDepth?: number;
  invalidResponses?: boolean;
  errorRate?: number;
}

export interface RequestLog {
  endpoint: string;
  timestamp: number;
  success: boolean;
  latency: number;
}

export class HorizonFake extends EventEmitter {
  private failureProfile: FailureProfile = {};
  private requestCount = 0;
  private ledgerSequence = 1000;
  private requestLogs: RequestLog[] = [];
  private currentCursor: string = '0';

  setFailureProfile(profile: FailureProfile) {
    this.failureProfile = profile;
    this.emit('profileChanged', profile);
  }

  getFailureProfile(): FailureProfile {
    return this.failureProfile;
  }

  async simulateRequest(endpoint: string): Promise<any> {
    const startTime = Date.now();
    this.requestCount++;
    let success = true;
    let response: any;

    try {
      // Simulate latency
      if (this.failureProfile.latencyMs) {
        await new Promise(resolve => setTimeout(resolve, this.failureProfile.latencyMs));
      }

      // Simulate random errors
      if (this.failureProfile.errorRate && Math.random() < this.failureProfile.errorRate) {
        throw new Error('Random simulated error');
      }

      // Simulate dropped connection
      if (this.failureProfile.dropConnection && this.requestCount % 2 === 0) {
        throw new Error('Connection dropped mid-stream');
      }

      // Simulate partial reads
      if (this.failureProfile.partialReads) {
        response = this.generatePartialResponse(endpoint);
      }
      // Simulate reorgs
      else if (this.failureProfile.reorgDepth) {
        response = this.generateReorgResponse(this.failureProfile.reorgDepth);
      } else {
        response = this.generateNormalResponse(endpoint);
      }

      success = true;
    } catch (error) {
      success = false;
      throw error;
    } finally {
      this.requestLogs.push({
        endpoint,
        timestamp: startTime,
        success,
        latency: Date.now() - startTime
      });
    }

    return response;
  }

  private generateNormalResponse(endpoint: string): any {
    const sequence = this.ledgerSequence++;
    this.currentCursor = String(sequence);
    
    return {
      _links: { 
        self: { href: endpoint },
        next: { href: `${endpoint}?cursor=${sequence}` }
      },
      ledger: sequence,
      cursor: this.currentCursor,
      records: Array.from({ length: 5 }, (_, i) => ({
        id: `event_${sequence}_${i}`,
        type: 'transaction',
        paging_token: `${sequence}-${i}`,
        created_at: new Date().toISOString()
      }))
    };
  }

  private generatePartialResponse(endpoint: string): any {
    const sequence = this.ledgerSequence++;
    
    // Return incomplete response - missing some fields
    return {
      _links: { 
        self: { href: endpoint }
        // Missing 'next' link
      },
      // Missing ledger field
      records: Array.from({ length: 3 }, (_, i) => ({
        id: `event_${sequence}_${i}`,
        // Missing type and other fields
      }))
    };
  }

  private generateReorgResponse(depth: number): any {
    // Simulate a reorg by rolling back the ledger
    const newSequence = Math.max(1, this.ledgerSequence - depth);
    this.ledgerSequence = newSequence;
    this.currentCursor = String(newSequence);
    
    return {
      _links: { 
        self: { href: '/ledgers' },
        next: { href: `/ledgers?cursor=${newSequence}` }
      },
      ledger: newSequence,
      cursor: this.currentCursor,
      reorg: true,
      reorgDepth: depth,
      records: Array.from({ length: 3 }, (_, i) => ({
        id: `reorg_event_${newSequence}_${i}`,
        type: 'transaction',
        paging_token: `${newSequence}-${i}`,
        created_at: new Date().toISOString()
      }))
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  getRequestLogs(): RequestLog[] {
    return this.requestLogs;
  }

  getCurrentCursor(): string {
    return this.currentCursor;
  }

  getLedgerSequence(): number {
    return this.ledgerSequence;
  }

  reset() {
    this.requestCount = 0;
    this.failureProfile = {};
    this.requestLogs = [];
    this.ledgerSequence = 1000;
    this.currentCursor = '0';
    this.emit('reset');
  }
}
