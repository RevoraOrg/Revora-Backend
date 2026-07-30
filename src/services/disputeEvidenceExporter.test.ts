import { DisputeEvidenceExporter } from "./disputeEvidenceExporter";
import { AuditLogRepository } from "../db/repositories/auditLogRepository";

describe("DisputeEvidenceExporter", () => {
  const originalSecret = process.env.DISPUTE_EVIDENCE_SIGNING_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.DISPUTE_EVIDENCE_SIGNING_SECRET;
    } else {
      process.env.DISPUTE_EVIDENCE_SIGNING_SECRET = originalSecret;
    }
    jest.restoreAllMocks();
  });

  it("builds a deterministic signed bundle with manifest hashes", async () => {
    const auditLogRepo = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    } as unknown as AuditLogRepository;
    const exporter = new DisputeEvidenceExporter({ auditLogRepo });

    const bundle = await exporter.exportEvidenceBundle({
      disputeId: "dispute-1",
      reviewerId: "reviewer-1",
      exportedAt: new Date("2025-01-01T00:00:00.000Z"),
      artifacts: [
        {
          id: "a1",
          name: "evidence.txt",
          content: "hello world",
          contentType: "text/plain",
          requestIdChain: ["req-1", "req-2"],
          reviewerId: "reviewer-1",
        },
      ],
    });

    expect(bundle.bundleVersion).toBe("v1");
    expect(bundle.artifactCount).toBe(1);
    expect(bundle.manifest.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.manifest.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.signature).toBeTruthy();
    expect(auditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispute.bundle.exported",
      }),
    );
  });

  it("rejects empty dispute ids and missing artifacts", async () => {
    const exporter = new DisputeEvidenceExporter();

    await expect(
      exporter.exportEvidenceBundle({
        disputeId: "   ",
        artifacts: [{ id: "a", name: "n", content: "x" }],
      }),
    ).rejects.toThrow("disputeId is required");
    await expect(
      exporter.exportEvidenceBundle({ disputeId: "d1", artifacts: [] as any }),
    ).rejects.toThrow("At least one artifact is required");
  });

  it("uses the dispute-specific signing secret when configured", async () => {
    process.env.DISPUTE_EVIDENCE_SIGNING_SECRET = "secret-123";
    const exporter = new DisputeEvidenceExporter();

    const bundle = await exporter.exportEvidenceBundle({
      disputeId: "d1",
      artifacts: [{ id: "a", name: "n", content: "x" }],
    });

    expect(bundle.signingKeyId).toBe("dispute-evidence-signing-key");
    expect(bundle.signature).toBeTruthy();
  });
});
