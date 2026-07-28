import { OFACReviewRepository } from './ofacReviewRepository';

class MockClient {
  constructor(private pool: MockPool) {}

  async query(text: string, values?: any[]): Promise<any> {
    return this.pool.query(text, values);
  }

  release(): void {}
}

class MockPool {
  reviews: any[] = [];
  queries: string[] = [];

  async connect(): Promise<MockClient> {
    return new MockClient(this);
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
      return { rows: this.reviews.filter(review => review.id === values[0]) };
    }

    if (text.includes('SELECT * FROM ofac_reviews WHERE id = $1')) {
      return { rows: this.reviews.filter(review => review.id === values[0]) };
    }

    if (text.includes("WHERE status IN ('pending_first_approval', 'pending_second_approval')")) {
      return {
        rows: this.reviews.filter(review =>
          review.status === 'pending_first_approval' || review.status === 'pending_second_approval'
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
        }
      }
      return { rows: [] };
    }

    if (text.includes('WHERE id = $1 AND expires_at <= $2')) {
      const review = this.reviews.find(item => item.id === values[0] && item.expires_at <= values[1]);
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
      const review = this.reviews.find(item => item.id === values[3]);
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
      const review = this.reviews.find(item => item.id === values[4]);
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

describe('OFACReviewRepository', () => {
  let pool: MockPool;
  let repository: OFACReviewRepository;

  beforeEach(() => {
    pool = new MockPool();
    repository = new OFACReviewRepository(pool as any);
  });

  it('should create and list queued reviews', async () => {
    const review = await repository.create({
      alert_id: 'alert_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      rationale: 'Legal name collision with supporting KYC evidence.',
    }, 'creator_1');

    const queue = await repository.findQueue();

    expect(review.status).toBe('pending_first_approval');
    expect(queue).toHaveLength(1);
    expect(queue[0].alert_id).toBe('alert_1');
  });

  it('should clear after two independent approvals', async () => {
    const review = await repository.create({
      alert_id: 'alert_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      rationale: 'Legal name collision with supporting KYC evidence.',
    }, 'creator_1');

    const first = await repository.approve(review.id, 'officer_1', 'DOB mismatch verified.');
    const cleared = await repository.approve(review.id, 'officer_2', 'Address and passport mismatch verified.');

    expect(first.status).toBe('pending_second_approval');
    expect(cleared.status).toBe('cleared');
    expect(cleared.clearance_rationale).toContain('officer_2');
  });

  it('should return null when a review cannot be found', async () => {
    await expect(repository.findById('missing_review')).resolves.toBeNull();
  });

  it('should reject creator approval and same-user second approval', async () => {
    const review = await repository.create({
      alert_id: 'alert_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      rationale: 'Legal name collision with supporting KYC evidence.',
    }, 'creator_1');

    await expect(repository.approve(review.id, 'creator_1', 'Self approval')).rejects.toThrow('creator cannot approve');
    await repository.approve(review.id, 'officer_1', 'First independent approval.');
    await expect(repository.approve(review.id, 'officer_1', 'Second approval')).rejects.toThrow('cannot approve an OFAC review twice');
  });

  it('should reject missing and already-cleared reviews', async () => {
    await expect(repository.approve('missing_review', 'officer_1', 'No row')).rejects.toThrow('not found');

    const review = await repository.create({
      alert_id: 'alert_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      rationale: 'Legal name collision with supporting KYC evidence.',
    }, 'creator_1');
    await repository.approve(review.id, 'officer_1', 'First independent approval.');
    await repository.approve(review.id, 'officer_2', 'Second independent approval.');

    await expect(repository.approve(review.id, 'officer_3', 'Third approval')).rejects.toThrow('already cleared');
  });

  it('should reset expired reviews before accepting a new first approval', async () => {
    const expiresAt = new Date(Date.now() + 1000);
    const review = await repository.create({
      alert_id: 'alert_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      rationale: 'Legal name collision with supporting KYC evidence.',
      expires_at: expiresAt,
    }, 'creator_1');

    await repository.approve(review.id, 'officer_1', 'First independent approval.');
    const reset = await repository.approve(
      review.id,
      'officer_2',
      'Expired prior approval, starting approval again.',
      new Date(expiresAt.getTime() + 1000)
    );

    expect(reset.status).toBe('pending_second_approval');
    expect(reset.first_approver_id).toBe('officer_2');
  });

  it('should reset expired pending second approvals into the queue', async () => {
    const expiresAt = new Date(Date.now() + 1000);
    const review = await repository.create({
      alert_id: 'alert_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      rationale: 'Legal name collision with supporting KYC evidence.',
      expires_at: expiresAt,
    }, 'creator_1');

    await repository.approve(review.id, 'officer_1', 'First independent approval.');
    const queue = await repository.findQueue(new Date(expiresAt.getTime() + 1000));

    expect(queue[0].status).toBe('pending_first_approval');
    expect(queue[0].first_approver_id).toBeUndefined();
  });
});
