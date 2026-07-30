import { createHash, createHmac } from "crypto";
import { AuditLogRepository } from "../db/repositories/auditLogRepository";
import { Logger, globalLogger } from "../lib/logger";
import { Errors } from "../lib/errors";

/**
 * Stored artifact that contributes to a dispute evidence bundle export.
 *
 * The exporter hashes the artifact contents deterministically and records
 * reviewer and request-chain metadata in the manifest so the bundle can be
 * reproduced from the stored artifacts alone.
 */
export interface DisputeEvidenceArtifact {
  id: string;
  name: string;
  content: string | Buffer;
  requestIdChain?: string[];
  reviewerId?: string;
  contentType?: string;
}

/**
 * A signed dispute evidence bundle export payload.
 */
export interface DisputeEvidenceBundle {
  disputeId: string;
  exportedAt: string;
  bundleVersion: "v1";
  artifactCount: number;
  manifest: {
    disputeId: string;
    exportedAt: string;
    artifactCount: number;
    artifacts: Array<{
      id: string;
      name: string;
      sha256: string;
      requestIdChain: string[];
      reviewerId?: string;
      contentType?: string;
      sizeBytes: number;
    }>;
    canonicalHash: string;
  };
  artifacts: Array<{
    id: string;
    name: string;
    contentType?: string;
    contentBase64: string;
  }>;
  signature: string;
  signingAlgorithm: "hmac-sha256-v1";
  signingKeyId: string;
}

export interface DisputeEvidenceExporterDeps {
  auditLogRepo?: AuditLogRepository;
  logger?: Logger;
}

/**
 * Builds a reproducible, cryptographically signed evidence bundle for a dispute.
 *
 * The bundle contains a manifest with each artifact's SHA-256 hash, request-id
 * chain, and reviewer identity, plus the artifact payloads encoded as base64 so
 * the export can be reproduced from the stored artifacts.
 */
export class DisputeEvidenceExporter {
  private readonly auditLogRepo?: AuditLogRepository;
  private readonly logger: Logger;

  constructor(deps: DisputeEvidenceExporterDeps = {}) {
    this.auditLogRepo = deps.auditLogRepo;
    this.logger = deps.logger ?? globalLogger;
  }

  async exportEvidenceBundle(input: {
    disputeId: string;
    artifacts: DisputeEvidenceArtifact[];
    reviewerId?: string;
    exportedAt?: Date;
  }): Promise<DisputeEvidenceBundle> {
    const disputeId = input.disputeId?.trim();
    if (!disputeId) {
      throw Errors.badRequest("disputeId is required");
    }

    if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
      throw Errors.badRequest("At least one artifact is required");
    }

    const exportedAt = input.exportedAt ?? new Date();
    const exportedAtIso = exportedAt.toISOString();

    const normalizedArtifacts = input.artifacts.map((artifact, index) => {
      if (!artifact?.id) {
        throw Errors.badRequest(`Artifact at index ${index} is missing an id`);
      }
      if (!artifact?.name) {
        throw Errors.badRequest(`Artifact at index ${index} is missing a name`);
      }
      if (artifact.content === undefined || artifact.content === null) {
        throw Errors.badRequest(`Artifact ${artifact.id} is missing content`);
      }

      const buffer = this.toBuffer(artifact.content);
      return {
        id: artifact.id,
        name: artifact.name,
        contentType: artifact.contentType,
        contentBase64: buffer.toString("base64"),
        contentBuffer: buffer,
        requestIdChain: Array.isArray(artifact.requestIdChain)
          ? artifact.requestIdChain
          : [],
        reviewerId: artifact.reviewerId ?? input.reviewerId,
        sizeBytes: buffer.byteLength,
      };
    });

    const manifestArtifacts = normalizedArtifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      sha256: this.sha256Hex(artifact.contentBuffer),
      requestIdChain: artifact.requestIdChain,
      reviewerId: artifact.reviewerId,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
    }));

    const manifest = {
      disputeId,
      exportedAt: exportedAtIso,
      artifactCount: manifestArtifacts.length,
      artifacts: manifestArtifacts,
    };

    const canonicalManifest = this.canonicalize(manifest);
    const canonicalHash = this.sha256Hex(
      Buffer.from(canonicalManifest, "utf8"),
    );
    const signingSecret = this.resolveSigningSecret();
    const signature = createHmac("sha256", signingSecret)
      .update(canonicalManifest)
      .digest("hex");

    const bundle: DisputeEvidenceBundle = {
      disputeId,
      exportedAt: exportedAtIso,
      bundleVersion: "v1",
      artifactCount: manifestArtifacts.length,
      manifest: {
        ...manifest,
        canonicalHash,
      },
      artifacts: normalizedArtifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        contentType: artifact.contentType,
        contentBase64: artifact.contentBase64,
      })),
      signature,
      signingAlgorithm: "hmac-sha256-v1",
      signingKeyId: this.resolveSigningKeyId(),
    };

    await this.createAuditLog({
      action: "dispute.bundle.exported",
      resource: `dispute:${disputeId}`,
      details: JSON.stringify({
        disputeId,
        artifactCount: manifestArtifacts.length,
        canonicalHash,
        signaturePrefix: signature.slice(0, 12),
      }),
    });

    return bundle;
  }

  private resolveSigningSecret(): string {
    return (
      process.env.DISPUTE_EVIDENCE_SIGNING_SECRET ??
      process.env.AUDIT_LOG_SIGNING_SECRET ??
      process.env.SLA_REPORT_SIGNING_SECRET ??
      "revora-dispute-evidence-default-secret"
    );
  }

  private resolveSigningKeyId(): string {
    if (process.env.AUDIT_LOG_SIGNING_SECRET) {
      return "audit-log-signing-key";
    }
    if (process.env.DISPUTE_EVIDENCE_SIGNING_SECRET) {
      return "dispute-evidence-signing-key";
    }
    return "default-signing-key";
  }

  private sha256Hex(value: Buffer): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private toBuffer(content: string | Buffer): Buffer {
    return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  }

  private canonicalize(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.canonicalize(entry)).join(",")}]`;
    }

    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).sort(
        ([left], [right]) => left.localeCompare(right),
      );
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${this.canonicalize(entry)}`).join(",")}}`;
    }

    return JSON.stringify(value);
  }

  private async createAuditLog(input: {
    action: string;
    resource: string;
    details: string;
  }): Promise<void> {
    if (!this.auditLogRepo) {
      return;
    }

    try {
      await this.auditLogRepo.createAuditLog({
        user_id: null,
        action: input.action,
        resource: input.resource,
        details: input.details,
      });
    } catch (error) {
      this.logger.error("Failed to create dispute evidence bundle audit log", {
        action: input.action,
        error,
      });
    }
  }
}
