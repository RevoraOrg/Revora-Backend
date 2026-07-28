/**
 * KMS Key Provider Interface and Implementation
 * 
 * Provides KMS-managed key lifecycle operations and column-level encryption / decryption primitives.
 */

import crypto from 'crypto';

export interface EncryptedColumnData {
  ciphertext: string;
  keyGeneration: number;
}

export interface KMSKeyProvider {
  /** Get the current active key generation version */
  getCurrentKeyGeneration(): number;
  
  /** Rotate KMS key to produce a new key generation version */
  rotateKey(): Promise<number>;

  /** Encrypt plain text using specified key generation (or active key generation if omitted) */
  encrypt(plaintext: string, keyGen?: number): Promise<EncryptedColumnData>;

  /** Decrypt cipher text using specified key generation */
  decrypt(ciphertext: string, keyGen: number): Promise<string>;

  /** Check if specified key generation is supported */
  hasKeyGeneration(keyGen: number): boolean;

  /** Register or import an explicit key for a specific key generation */
  addKeyGeneration(keyGen: number, key: Buffer): void;
}

export class LocalKMSKeyProvider implements KMSKeyProvider {
  private keyMap: Map<number, Buffer> = new Map();
  private activeGeneration: number = 1;

  constructor(initialKey?: Buffer, initialGeneration = 1) {
    this.activeGeneration = initialGeneration;
    const key = initialKey ?? crypto.randomBytes(32);
    if (key.length !== 32) {
      throw new Error('KMS key must be 32 bytes for AES-256 encryption');
    }
    this.keyMap.set(initialGeneration, key);
  }

  getCurrentKeyGeneration(): number {
    return this.activeGeneration;
  }

  async rotateKey(): Promise<number> {
    const nextGeneration = this.activeGeneration + 1;
    const newKey = crypto.randomBytes(32);
    this.keyMap.set(nextGeneration, newKey);
    this.activeGeneration = nextGeneration;
    return nextGeneration;
  }

  hasKeyGeneration(keyGen: number): boolean {
    return this.keyMap.has(keyGen);
  }

  addKeyGeneration(keyGen: number, key: Buffer): void {
    if (key.length !== 32) {
      throw new Error('KMS key must be 32 bytes for AES-256 encryption');
    }
    this.keyMap.set(keyGen, key);
    if (keyGen > this.activeGeneration) {
      this.activeGeneration = keyGen;
    }
  }

  async encrypt(plaintext: string, keyGen?: number): Promise<EncryptedColumnData> {
    const generation = keyGen ?? this.activeGeneration;
    const key = this.keyMap.get(generation);
    if (!key) {
      throw new Error(`KMS key generation ${generation} not found`);
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    // Format: iv:authTag:encrypted
    const payload = `${iv.toString('hex')}:${authTag}:${encrypted}`;

    return {
      ciphertext: payload,
      keyGeneration: generation,
    };
  }

  async decrypt(ciphertext: string, keyGen: number): Promise<string> {
    const key = this.keyMap.get(keyGen);
    if (!key) {
      throw new Error(`KMS key generation ${keyGen} not found`);
    }

    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format for KMS decryption');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
