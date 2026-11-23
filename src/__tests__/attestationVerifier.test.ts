import { verifyReproducibleBuildAttestation } from '../security/attestationVerifier';

describe('verifyReproducibleBuildAttestation', () => {
  it('verifies a valid SLSA-style attestation and matches the target code id', () => {
    const attestation = {
      builder: { id: 'builder-1' },
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject: [
        {
          name: 'revora-contract',
          digest: { sha256: 'deadbeefcafebabe000000000000000000000000000000000000000000000000' },
        },
      ],
    };

    const result = verifyReproducibleBuildAttestation(
      attestation,
      'deadbeefcafebabe000000000000000000000000000000000000000000000000',
      ['builder-1'],
    );

    expect(result).toEqual({
      builderId: 'builder-1',
      subjectDigest: 'deadbeefcafebabe000000000000000000000000000000000000000000000000',
      subjectName: 'revora-contract',
    });
  });

  it('rejects an attestation from an unknown builder', () => {
    const attestation = {
      builder: { id: 'unknown-builder' },
      subject: [
        {
          name: 'revora-contract',
          digest: { sha256: 'abcdef' },
        },
      ],
    };

    expect(() =>
      verifyReproducibleBuildAttestation(attestation, 'abcdef', ['builder-1']),
    ).toThrow('Attestation builder identity is not authorized for tenant');
  });

  it('rejects an attestation when the subject cannot be matched to the target code id', () => {
    const attestation = {
      builder: { id: 'builder-1' },
      subject: [
        {
          name: 'other-contract',
          digest: { sha256: 'cafebabe' },
        },
      ],
    };

    expect(() =>
      verifyReproducibleBuildAttestation(attestation, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation subject payload does not contain a matching target code identifier');
  });

  it('rejects missing builder identity in the attestation', () => {
    const attestation = {
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject: [
        {
          digest: { sha256: 'deadbeef' },
        },
      ],
    };

    expect(() =>
      verifyReproducibleBuildAttestation(attestation, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation missing builder.id');
  });

  it('throws error when attestation is not an object (null, undefined, primitives)', () => {
    expect(() =>
      verifyReproducibleBuildAttestation(null, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation must be an object');

    expect(() =>
      verifyReproducibleBuildAttestation(undefined, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation must be an object');

    expect(() =>
      verifyReproducibleBuildAttestation('not-an-object', 'deadbeef', ['builder-1']),
    ).toThrow('Attestation must be an object');

    expect(() =>
      verifyReproducibleBuildAttestation(123, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation must be an object');
  });

  it('throws error when builder.id is missing, empty, or not a string (boundary inputs)', () => {
    expect(() =>
      verifyReproducibleBuildAttestation({}, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation missing builder.id');

    expect(() =>
      verifyReproducibleBuildAttestation({ builder: {} }, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation missing builder.id');

    expect(() =>
      verifyReproducibleBuildAttestation({ builder: { id: '' } }, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation missing builder.id');

    expect(() =>
      verifyReproducibleBuildAttestation({ builder: { id: '   ' } }, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation missing builder.id');

    expect(() =>
      verifyReproducibleBuildAttestation({ builder: { id: 123 } }, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation missing builder.id');
  });

  it('throws error when builder identity is not authorized for tenant', () => {
    expect(() =>
      verifyReproducibleBuildAttestation({ builder: { id: 'builder-2' } }, 'deadbeef', ['builder-1']),
    ).toThrow('Attestation builder identity is not authorized for tenant');
  });

  it('verifies normal path with subject matching by name (case/whitespace normalization)', () => {
    const attestation = {
      builder: { id: 'builder-1' },
      subject: [
        {
          name: '  Revora-Contract  ',
        },
      ],
    };

    const result = verifyReproducibleBuildAttestation(
      attestation,
      'revora-contract',
      ['builder-1'],
    );

    expect(result).toEqual({
      builderId: 'builder-1',
      subjectDigest: 'revora-contract',
      subjectName: 'Revora-Contract',
    });
  });

  it('verifies normal path with unsupported predicate type error', () => {
    const attestation = {
      builder: { id: 'builder-1' },
      predicateType: 'https://slsa.dev/provenance/v0.1',
      subject: [
        {
          digest: { sha256: 'deadbeef' },
        },
      ],
    };

    expect(() =>
      verifyReproducibleBuildAttestation(attestation, 'deadbeef', ['builder-1']),
    ).toThrow('Unsupported attestation predicate type');
  });
});
