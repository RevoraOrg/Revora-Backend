import {
  assertNoPiiLeaks,
  findPiiLeaks,
  interactionByLabel,
  RECORDED_PROVIDERS,
  replayInteractions,
  replayProvider,
} from './replay';
import type { FixtureFile } from './recorder';

describe('AML fixture replay helpers', () => {
  it.each(RECORDED_PROVIDERS)('replays %s interactions and resolves their labels', async (provider) => {
    const fixture = await replayProvider(provider);
    const interactions = replayInteractions(fixture);

    expect(fixture.provider).toBe(provider);
    expect(interactions).toEqual(fixture.interactions);
    expect(interactions.length).toBeGreaterThan(0);

    for (const interaction of interactions) {
      expect(interactionByLabel(fixture, interaction.label)).toEqual(interaction);
    }

    expect(() => assertNoPiiLeaks(fixture)).not.toThrow();
  });

  it('returns undefined when a label is not present in the fixture', async () => {
    const fixture = await replayProvider('jumio');

    expect(interactionByLabel(fixture, 'missing_interaction')).toBeUndefined();
  });

  describe('PII leak detection', () => {
    let fixtureWithLeaks: FixtureFile;

    beforeEach(async () => {
      const fixture = await replayProvider('jumio');
      fixtureWithLeaks = {
        ...fixture,
        interactions: fixture.interactions.map((interaction, index) =>
          index === 0
            ? {
                ...interaction,
                request: {
                  ...interaction.request,
                  body: {
                    contact: 'replay-test@example.com',
                    firstName: 'Fixture Person',
                  },
                },
              }
            : interaction,
        ),
      };
    });

    it('detects an email value and a name under a sensitive key', () => {
      const leaks = findPiiLeaks(fixtureWithLeaks);

      expect(leaks).toEqual(expect.arrayContaining([
        expect.stringContaining('raw email value survived redaction'),
        expect.stringContaining('sensitive key holds a non-placeholder value'),
      ]));
    });

    it('throws when a fixture contains unredacted PII', () => {
      expect(() => assertNoPiiLeaks(fixtureWithLeaks)).toThrow(
        'Fixture "jumio" leaks PII',
      );
    });
  });
});
