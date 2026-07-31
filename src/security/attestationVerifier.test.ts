import { verifyReproducibleBuildAttestation } from './attestationVerifier';

describe('attestationVerifier', () => {
  const allowedBuilderIds = ['https://github.com/RevoraOrg/builder', 'https://github.com/trusted/builder'];
  const targetCodeId = 'abc123def456';

  it('should verify a valid attestation with matching builder and digest', () => {
    const validAttestation = {
      builder: { id: 'https://github.com/RevoraOrg/builder' },
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject: [
        {
          name: 'contract.wasm',
          digest: { sha256: targetCodeId }
        }
      ]
    };

    const result = verifyReproducibleBuildAttestation(validAttestation, targetCodeId, allowedBuilderIds);
    expect(result.builderId).toBe('https://github.com/RevoraOrg/builder');
    expect(result.subjectDigest).toBe(targetCodeId);
  });

  it('should reject attestation from unknown builder', () => {
    const unknownBuilderAttestation = {
      builder: { id: 'https://github.com/malicious/builder' },
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject: [
        {
          name: 'contract.wasm',
          digest: { sha256: targetCodeId }
        }
      ]
    };

    expect(() => {
      verifyReproducibleBuildAttestation(unknownBuilderAttestation, targetCodeId, allowedBuilderIds);
    }).toThrow('Attestation builder identity is not authorized for tenant');
  });

  it('should reject attestation missing builder id', () => {
    const missingBuilderAttestation = {
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject: [
        {
          name: 'contract.wasm',
          digest: { sha256: targetCodeId }
        }
      ]
    };

    expect(() => {
      verifyReproducibleBuildAttestation(missingBuilderAttestation, targetCodeId, allowedBuilderIds);
    }).toThrow('Attestation missing builder.id');
  });

  it('should reject attestation not matching target code id', () => {
    const mismatchAttestation = {
      builder: { id: 'https://github.com/RevoraOrg/builder' },
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject: [
        {
          name: 'contract.wasm',
          digest: { sha256: 'someotherdigest' }
        }
      ]
    };

    expect(() => {
      verifyReproducibleBuildAttestation(mismatchAttestation, targetCodeId, allowedBuilderIds);
    }).toThrow('Attestation subject payload does not contain a matching target code identifier');
  });

  it('should accept when name matches target code id but digest does not', () => {
    const nameMatchAttestation = {
      builder: { id: 'https://github.com/RevoraOrg/builder' },
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject: [
        {
          name: targetCodeId,
          digest: { sha256: 'someotherdigest' }
        }
      ]
    };

    const result = verifyReproducibleBuildAttestation(nameMatchAttestation, targetCodeId, allowedBuilderIds);
    expect(result.builderId).toBe('https://github.com/RevoraOrg/builder');
    expect(result.subjectName).toBe(targetCodeId);
  });

  it('should reject unsupported predicate type', () => {
    const badPredicateAttestation = {
      builder: { id: 'https://github.com/RevoraOrg/builder' },
      predicateType: 'https://slsa.dev/provenance/v1.0', // unsupported
      subject: [
        {
          name: 'contract.wasm',
          digest: { sha256: targetCodeId }
        }
      ]
    };

    expect(() => {
      verifyReproducibleBuildAttestation(badPredicateAttestation, targetCodeId, allowedBuilderIds);
    }).toThrow('Unsupported attestation predicate type');
  });

  it('should reject if attestation is not an object', () => {
    expect(() => {
      verifyReproducibleBuildAttestation(null, targetCodeId, allowedBuilderIds);
    }).toThrow('Attestation must be an object');

    expect(() => {
      verifyReproducibleBuildAttestation('string_attestation', targetCodeId, allowedBuilderIds);
    }).toThrow('Attestation must be an object');
  });
});
