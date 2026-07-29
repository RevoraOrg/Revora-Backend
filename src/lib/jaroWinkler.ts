/**
 * Jaro-Winkler Distance and String Normalization Utility
 * 
 * Provides string matching algorithms with Cyrillic-to-Latin transliteration
 * support for AML sanctions screening.
 */

// Cyrillic to Latin transliteration character map (ISO 9 standard variant)
const CYRILLIC_TO_LATIN_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo',
  'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
  'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
  'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch',
  'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
};

/**
 * Transliterates Cyrillic characters into Latin equivalents.
 * @param str Input string
 * @returns Transliterated string in Latin characters
 */
export function transliterateCyrillic(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    result += CYRILLIC_TO_LATIN_MAP[char] ?? char;
  }
  return result;
}

/**
 * Normalizes a name string by converting to lowercase, transliterating Cyrillic,
 * stripping diacritics, and collapsing whitespace.
 * @param str Input name
 * @returns Clean, normalized name string
 */
export function normalizeName(str: string): string {
  if (!str) return '';
  
  // Transliterate Cyrillic to Latin first
  let normalized = transliterateCyrillic(str);
  
  // Normalize unicode (NFD) to separate base characters and diacritical marks
  normalized = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // Replace non-alphanumeric punctuation with spaces
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();

  return normalized;
}

/**
 * Calculates Jaro distance between two strings.
 * Returns a value between 0.0 (no match) and 1.0 (exact match).
 */
export function jaroDistance(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2 || s1.length === 0 || s2.length === 0) return 0.0;

  const len1 = s1.length;
  const len2 = s2.length;

  const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);

  const s1Matches = new Array<boolean>(len1).fill(false);
  const s2Matches = new Array<boolean>(len2).fill(false);

  let matches = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(len2 - 1, i + matchWindow);

    for (let j = start; j <= end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;

  for (let i = 0; i < len1; i++) {
    if (s1Matches[i]) {
      while (!s2Matches[k]) {
        k++;
      }
      if (s1[i] !== s2[k]) {
        transpositions++;
      }
      k++;
    }
  }

  const t = transpositions / 2.0;

  return (matches / len1 + matches / len2 + (matches - t) / matches) / 3.0;
}

export interface JaroWinklerOptions {
  p?: number; // Scaling factor (default: 0.1, max: 0.25)
  maxPrefixLength?: number; // Max prefix length to consider (default: 4)
  transliterate?: boolean; // Whether to normalize and transliterate before comparison (default: true)
}

/**
 * Calculates Jaro-Winkler similarity between two strings.
 * Returns a value between 0.0 (no match) and 1.0 (exact match).
 */
export function jaroWinkler(s1: string, s2: string, options?: JaroWinklerOptions): number {
  if (s1 === s2) return 1.0;

  const p = Math.min(0.25, Math.max(0.0, options?.p ?? 0.1));
  const maxPrefixLength = options?.maxPrefixLength ?? 4;
  const shouldTransliterate = options?.transliterate ?? true;

  const str1 = shouldTransliterate ? normalizeName(s1) : s1;
  const str2 = shouldTransliterate ? normalizeName(s2) : s2;

  if (str1 === str2) return 1.0;

  const jaro = jaroDistance(str1, str2);

  if (jaro <= 0.0) return 0.0;

  // Calculate common prefix length up to maxPrefixLength
  let l = 0;
  const minLength = Math.min(str1.length, str2.length, maxPrefixLength);
  for (let i = 0; i < minLength; i++) {
    if (str1[i] === str2[i]) {
      l++;
    } else {
      break;
    }
  }

  const jw = jaro + l * p * (1 - jaro);
  return Math.min(1.0, Math.max(0.0, jw));
}
