import { jaroDistance, jaroWinkler, normalizeName, transliterateCyrillic } from './jaroWinkler';

describe('JaroWinkler Helper', () => {
  describe('transliterateCyrillic', () => {
    it('transliterates Cyrillic characters to Latin', () => {
      expect(transliterateCyrillic('Александр')).toBe('Aleksandr');
      expect(transliterateCyrillic('Владимир')).toBe('Vladimir');
      expect(transliterateCyrillic('Москва')).toBe('Moskva');
    });

    it('leaves non-Cyrillic characters intact', () => {
      expect(transliterateCyrillic('John Doe 123')).toBe('John Doe 123');
    });
  });

  describe('normalizeName', () => {
    it('normalizes case, whitespace, diacritics, and Cyrillic', () => {
      expect(normalizeName('  José   Márquez  ')).toBe('jose marquez');
      expect(normalizeName('Александр')).toBe('aleksandr');
      expect(normalizeName('')).toBe('');
    });
  });

  describe('jaroDistance', () => {
    it('returns 1.0 for identical strings', () => {
      expect(jaroDistance('MARTHA', 'MARTHA')).toBe(1.0);
    });

    it('returns 0.0 when one or both strings are empty', () => {
      expect(jaroDistance('', 'MARTHA')).toBe(0.0);
      expect(jaroDistance('MARTHA', '')).toBe(0.0);
    });

    it('calculates Jaro distance for known pairs', () => {
      // MARTHA vs MARHTA has 6 matches, 1 transposition
      const score = jaroDistance('MARTHA', 'MARHTA');
      expect(score).toBeCloseTo(0.944, 3);
    });
  });

  describe('jaroWinkler', () => {
    it('returns 1.0 for exact matches after normalization', () => {
      expect(jaroWinkler('Alexander', 'ALEXANDER')).toBe(1.0);
      expect(jaroWinkler('Александр', 'Aleksandr')).toBe(1.0);
    });

    it('detects similarity between Cyrillic-to-Latin transliterations', () => {
      // "Александр" transliterates to "aleksandr", comparing with "alexander"
      const score = jaroWinkler('Александр', 'Alexander');
      expect(score).toBeGreaterThanOrEqual(0.85);
    });

    it('detects similarity between "Владимир" and "Vladimir"', () => {
      const score = jaroWinkler('Владимир', 'Vladimir');
      expect(score).toBeGreaterThanOrEqual(0.85);
    });

    it('boosts score for common prefix', () => {
      const jaro = jaroDistance('MARTHA', 'MARHTA');
      const jw = jaroWinkler('MARTHA', 'MARHTA', { transliterate: false });
      expect(jw).toBeGreaterThan(jaro);
      expect(jw).toBeCloseTo(0.961, 3);
    });

    it('respects custom prefix length and scaling options', () => {
      const scoreCustom = jaroWinkler('MARTHA', 'MARHTA', { p: 0.2, maxPrefixLength: 2, transliterate: false });
      expect(scoreCustom).toBeGreaterThan(0);
    });

    it('returns 0.0 for completely disjoint strings', () => {
      expect(jaroWinkler('ABCDEF', 'XYZUVW')).toBe(0.0);
    });
  });
});
