export interface ReproducibleBuildAttestation {
  builder?: {
    id?: string;
    [key: string]: unknown;
  };
  subject?: Array<{
    name?: string;
    digest?: {
      sha256?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  predicateType?: string;
  [key: string]: unknown;
}

export interface VerifiedAttestation {
  builderId: string;
  subjectDigest: string;
  subjectName?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

export function verifyReproducibleBuildAttestation(
  attestation: unknown,
  targetCodeId: string,
  allowedBuilderIds: string[],
): VerifiedAttestation {
  if (!attestation || typeof attestation !== 'object') {
    throw new Error('Attestation must be an object');
  }

  const provenance = attestation as ReproducibleBuildAttestation;

  const builderId = isNonEmptyString(provenance.builder?.id)
    ? provenance.builder!.id.trim()
    : undefined;

  if (!builderId) {
    throw new Error('Attestation missing builder.id');
  }

  if (!allowedBuilderIds.includes(builderId)) {
    throw new Error('Attestation builder identity is not authorized for tenant');
  }

  if (provenance.predicateType && provenance.predicateType !== 'https://slsa.dev/provenance/v0.2') {
    throw new Error('Unsupported attestation predicate type');
  }

  const subjectRecords = Array.isArray(provenance.subject)
    ? provenance.subject
    : [];

  const normalizedTargetCodeId = normalizeHex(targetCodeId);

  for (const record of subjectRecords) {
    const name = isNonEmptyString(record.name) ? record.name.trim() : undefined;
    const digestSha256 = isNonEmptyString(record.digest?.sha256)
      ? normalizeHex(record.digest!.sha256)
      : undefined;

    if (digestSha256 === normalizedTargetCodeId || name === normalizedTargetCodeId) {
      return {
        builderId,
        subjectDigest: digestSha256 ?? normalizedTargetCodeId,
        subjectName: name,
      };
    }
  }

  throw new Error('Attestation subject payload does not contain a matching target code identifier');
}
