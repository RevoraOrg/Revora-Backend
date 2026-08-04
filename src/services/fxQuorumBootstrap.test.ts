import { bootstrapFxQuorumRouter } from './fxQuorumBootstrap';
import { InMemoryRateProvider } from './fxConversionEngine';
import { FxQuorumFailedError } from './fxQuorumEvaluator';

function makeProvider(mid: string): InMemoryRateProvider {
  const p = new InMemoryRateProvider();
  p.setRateFromValues('USD/EUR', mid, mid, mid);
  return p;
}

describe('bootstrapFxQuorumRouter', () => {
  it('rejects empty provider lists', () => {
    expect(() => bootstrapFxQuorumRouter({ providers: [] })).toThrow(/at least one/);
  });

  it('returns a quorum-enforcing router that pages on divergence', async () => {
    const paged: unknown[] = [];
    const { router } = bootstrapFxQuorumRouter({
      providers: [
        { id: 'a', provider: makeProvider('1.0000') },
        { id: 'b', provider: makeProvider('1.2000') },
      ],
      quorum: { k: 2, tolerance: 0.005 },
      pager: (f) => {
        paged.push(f);
      },
    });

    await expect(router.getRate('USD', 'EUR')).rejects.toBeInstanceOf(FxQuorumFailedError);
    await new Promise((r) => setTimeout(r, 10));
    expect(paged).toHaveLength(1);
  });

  it('meets quorum when one provider is down and N-1 agree', async () => {
    const down = new InMemoryRateProvider(); // no rates → null
    const { router } = bootstrapFxQuorumRouter({
      providers: [
        { id: 'a', provider: makeProvider('1.0000') },
        { id: 'b', provider: makeProvider('1.0010') },
        { id: 'c', provider: down },
      ],
      quorum: { k: 2, tolerance: 0.01, minValidProviders: 2 },
    });

    const rate = await router.getRate('USD', 'EUR');
    expect(rate).not.toBeNull();
    expect(Number(rate!.mid.toString())).toBeCloseTo(1.0005, 3);
  });
});
