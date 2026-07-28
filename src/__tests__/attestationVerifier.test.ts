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
});
