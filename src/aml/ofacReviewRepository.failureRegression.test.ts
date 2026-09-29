import { OFACReviewRepository } from './ofacReviewRepository';

/**
 * Regression coverage for the failure-handling paths of `OFACReviewRepository`.
 *
 * The repository turns unrecoverable state into thrown errors, and the caller
 * relies on the transaction being rolled back so a rejected clearance cannot
 * leave a half-applied approval behind. Three of those errors were already
 * asserted by `ofacReviewRepository.test.ts`. This suite adds the parts that
 * were not covered anywhere:
 *
 *   - the transaction contract (`BEGIN` + `ROLLBACK` on every rejection,
 *     `COMMIT` only on success);
 *   - state invariance: a rejected call must not mutate the locked row;
 *   - the inclusive expiry boundary (`expires_at === now` counts as expired);
 *   - `findQueue` reopening expired second approvals before it selects.
 *
 * The mock mirrors the SQL shapes issued by the repository, exactly as the
 * sibling suite does, and additionally records every statement so the
 * transaction framing can be asserted.
 */

class RecordingClient {
  constructor(private pool: RecordingPool) {}

  async query(text: string, values?: any[]): Promise<any> {
    return this.pool.query(text, values);
  }

  release(): void {}
}

class RecordingPool {
  reviews: any[] = [];
  queries: string[] = [];

  async connect(): Promise<RecordingClient> {
    return new RecordingClient(this);
  }

  /** Statements issued during the most recent `approve`/`findQueue` call. */
  since(index: number): string[] {
    return this.queries.slice(index);
  }

  async query(text: string, values: any[] = []): Promise<any> {
    this.queries.push(text);

    if (text.includes('INSERT INTO ofac_reviews')) {
      const row = {
        id: values[0],
        alert_id: values[1],
        case_id: values[2],
        investor_id: values[3],
        matched_name: values[4],
        list_entry_id: values[5],
        status: 'pending_first_approval',
        created_by: values[6],
        clearance_rationale: values[7],
        expires_at: values[8],
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.reviews.push(row);
      return { rows: [row] };
    }

    if (text.includes('SELECT * FROM ofac_reviews WHERE id = $1 FOR UPDATE')) {
      return { rows: this.reviews.filter((review) => review.id === values[0]) };
    }

    if (text.includes('SELECT * FROM ofac_reviews WHERE id = $1')) {
      return { rows: this.reviews.filter((review) => review.id === values[0]) };
    }

    if (text.includes("WHERE status IN ('pending_first_approval', 'pending_second_approval')")) {
      return {
        rows: this.reviews.filter(
          (review) =>
            review.status === 'pending_first_approval' ||
            review.status === 'pending_second_approval',
        ),
      };
    }

    if (text.includes("WHERE status = 'pending_second_approval' AND expires_at <= $1")) {
      for (const review of this.reviews) {
        if (review.status === 'pending_second_approval' && review.expires_at <= values[0]) {
          review.status = 'pending_first_approval';
          review.first_approver_id = null;
          review.first_approval_rationale = null;
          review.first_approved_at = null;
          review.second_approver_id = null;
          review.second_approval_rationale = null;
          review.second_approved_at = null;
          review.cleared_at = null;
        }
      }
      return { rows: [] };
    }

    if (text.includes('WHERE id = $1 AND expires_at <= $2')) {
      const review = this.reviews.find(
        (item) => item.id === values[0] && item.expires_at <= values[1],
      );
      Object.assign(review, {
        status: 'pending_first_approval',
        first_approver_id: null,
        first_approval_rationale: null,
        first_approved_at: null,
        second_approver_id: null,
        second_approval_rationale: null,
        second_approved_at: null,
        cleared_at: null,
        updated_at: new Date(),
      });
      return { rows: [review] };
    }

    if (text.includes("SET status = 'pending_second_approval'")) {
      const review = this.reviews.find((item) => item.id === values[3]);
      Object.assign(review, {
        status: 'pending_second_approval',
        first_approver_id: values[0],
        first_approval_rationale: values[1],
        first_approved_at: values[2],
        updated_at: new Date(),
      });
      return { rows: [review] };
    }

    if (text.includes("SET status = 'cleared'")) {
      const review = this.reviews.find((item) => item.id === values[4]);
      Object.assign(review, {
        status: 'cleared',
        second_approver_id: values[0],
        second_approval_rationale: values[1],
        second_approved_at: values[2],
        clearance_rationale: values[3],
        cleared_at: values[2],
        updated_at: new Date(),
      });
      return { rows: [review] };
    }

    if (text.trim() === 'BEGIN' || text.trim() === 'COMMIT' || text.trim() === 'ROLLBACK') {
      return { rows: [] };
    }

    return { rows: [] };
  }
}

describe('OFACReviewRepository failure handling', () => {
  let pool: RecordingPool;
  let repository: OFACReviewRepository;

  /** Create a pending review, optionally with a pinned expiry. */
  async function seed(opts: { createdBy?: string; expiresAt?: Date } = {}) {
    return repository.create(
      {
        alert_id: 'alert_1',
        investor_id: 'investor_1',
        matched_name: 'John Smith',
        rationale: 'Legal name collision with supporting KYC evidence.',
        ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
      },
      opts.createdBy ?? 'creator_1',
    );
  }

  beforeEach(() => {
    pool = new RecordingPool();
    repository = new OFACReviewRepository(pool as any);
  });

  it('reports a missing review and rolls the transaction back', async () => {
    const mark = pool.queries.length;

    await expect(repository.approve('missing_review', 'officer_1', 'No row')).rejects.toThrow(
      'OFAC review missing_review not found',
    );

    const stmts = pool.since(mark);
    expect(stmts).toContain('BEGIN');
    expect(stmts).toContain('ROLLBACK');
    expect(stmts).not.toContain('COMMIT');
  });

  it('rejects a cleared review and leaves the cleared row untouched', async () => {
    const review = await seed();
    await repository.approve(review.id, 'officer_1', 'First independent approval.');
    await repository.approve(review.id, 'officer_2', 'Second independent approval.');

    const before = { ...pool.reviews[0] };
    const mark = pool.queries.length;

    await expect(repository.approve(review.id, 'officer_3', 'Third approval')).rejects.toThrow(
      `OFAC review ${review.id} is already cleared`,
    );

    expect(pool.since(mark)).toContain('ROLLBACK');
    expect(pool.since(mark)).not.toContain('COMMIT');
    expect(pool.reviews[0].status).toBe(before.status);
    expect(pool.reviews[0].second_approver_id).toBe(before.second_approver_id);
    expect(pool.reviews[0].cleared_at).toEqual(before.cleared_at);
  });

  it('rejects creator self-approval without advancing the review', async () => {
    const review = await seed({ createdBy: 'creator_1' });
    const before = { ...pool.reviews[0] };
    const mark = pool.queries.length;

    await expect(
      repository.approve(review.id, 'creator_1', 'Self approval'),
    ).rejects.toThrow('Review creator cannot approve their own OFAC clearance');

    expect(pool.since(mark)).toContain('ROLLBACK');
    expect(pool.reviews[0].status).toBe('pending_first_approval');
    expect(pool.reviews[0].status).toBe(before.status);
    expect(pool.reviews[0].first_approver_id).toBeUndefined();
  });

  it('rejects a repeat approval by the same officer without clearing', async () => {
    const review = await seed();
    await repository.approve(review.id, 'officer_1', 'First independent approval.');

    const before = { ...pool.reviews[0] };
    const mark = pool.queries.length;

    await expect(repository.approve(review.id, 'officer_1', 'Second approval')).rejects.toThrow(
      'Same compliance officer cannot approve an OFAC review twice',
    );

    expect(pool.since(mark)).toContain('ROLLBACK');
    expect(pool.reviews[0].status).toBe('pending_second_approval');
    expect(pool.reviews[0].status).toBe(before.status);
    expect(pool.reviews[0].second_approver_id).toBeUndefined();
  });

  it('commits a single successful first approval and never rolls back', async () => {
    const review = await seed();
    const mark = pool.queries.length;

    const first = await repository.approve(review.id, 'officer_1', 'DOB mismatch verified.');

    const stmts = pool.since(mark);
    expect(stmts).toContain('BEGIN');
    expect(stmts).toContain('COMMIT');
    expect(stmts).not.toContain('ROLLBACK');
    expect(first.status).toBe('pending_second_approval');
    expect(first.first_approver_id).toBe('officer_1');
  });

  it('commits a full two-officer clearance with both rationales recorded', async () => {
    const review = await seed();
    await repository.approve(review.id, 'officer_1', 'DOB mismatch verified.');
    const mark = pool.queries.length;

    const cleared = await repository.approve(
      review.id,
      'officer_2',
      'Address and passport mismatch verified.',
    );

    expect(pool.since(mark)).toContain('COMMIT');
    expect(pool.since(mark)).not.toContain('ROLLBACK');
    expect(cleared.status).toBe('cleared');
    expect(cleared.clearance_rationale).toContain('officer_1');
    expect(cleared.clearance_rationale).toContain('officer_2');
  });

  it('treats an expiry exactly equal to now as expired (inclusive bound)', async () => {
    const expiresAt = new Date(Date.now() + 1_000);
    const review = await seed({ expiresAt });
    await repository.approve(review.id, 'officer_1', 'First independent approval.');

    // now === expires_at must take the reset path, so the approval is re-recorded as a first approval.
    const reset = await repository.approve(
      review.id,
      'officer_2',
      'Expired prior approval, starting approval again.',
      new Date(expiresAt.getTime()),
    );

    expect(reset.status).toBe('pending_second_approval');
    expect(reset.first_approver_id).toBe('officer_2');
  });

  it('treats an expiry one millisecond in the future as still valid', async () => {
    const expiresAt = new Date(Date.now() + 1_000);
    const review = await seed({ expiresAt });
    await repository.approve(review.id, 'officer_1', 'First independent approval.');

    const cleared = await repository.approve(
      review.id,
      'officer_2',
      'Second independent approval.',
      new Date(expiresAt.getTime() - 1),
    );

    expect(cleared.status).toBe('cleared');
    expect(cleared.second_approver_id).toBe('officer_2');
  });

  it('reopens expired second approvals before selecting the queue', async () => {
    const expiresAt = new Date(Date.now() + 1_000);
    const review = await seed({ expiresAt });
    await repository.approve(review.id, 'officer_1', 'First independent approval.');

    const mark = pool.queries.length;
    const queue = await repository.findQueue(new Date(expiresAt.getTime() + 1_000));

    // The reopen UPDATE must be issued before the queue SELECT.
    const stmts = pool.since(mark);
    const reopenIdx = stmts.findIndex((s) => s.includes("SET status = 'pending_first_approval'"));
    const selectIdx = stmts.findIndex((s) =>
      s.includes("WHERE status IN ('pending_first_approval', 'pending_second_approval')"),
    );
    expect(reopenIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(reopenIdx);

    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending_first_approval');
    expect(queue[0].first_approver_id).toBeUndefined();
  });

  it('returns null for an unknown review without issuing a transaction', async () => {
    const mark = pool.queries.length;

    await expect(repository.findById('missing_review')).resolves.toBeNull();

    expect(pool.since(mark)).not.toContain('BEGIN');
  });
});
