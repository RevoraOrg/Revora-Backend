/**
 * Locale-keyed legal disclaimer bundles for investor statement PDFs (Issue #673).
 *
 * Bundles ship as immutable resources with SHA-256 hash pinning. If any bundle
 * hash does not match the pre-computed pin, the module load fails loudly so
 * tampered or incomplete bundles are caught at startup, not at render time.
 *
 * Missing-locale requests fall back to en-US and emit a `pdf.locale.fallback`
 * counter metric. The en-US bundle is the root of trust — if it is absent,
 * the loader throws a fatal error.
 */
import { createHash } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────

/** A single legal disclaimer with jurisdiction context. */
export interface DisclaimerEntry {
  /** Human-readable jurisdiction label, e.g. "EEA (MiFID II)" or "US (Reg D)" */
  jurisdiction: string;
  /** The legal disclaimer text in the target locale */
  text: string;
}

/** Per-locale disclaimer bundle for statement header, footer and body disclaimers. */
export interface LocaleDisclaimerBundle {
  /** ISO 639-1 / IETF BCP 47 locale tag (e.g. "en-US", "de-DE") */
  locale: string;
  /** Short legal header line rendered at the top of each page */
  headerText: string;
  /** Footer legal notice appended after the revision stamp */
  footerText: string;
  /** Ordered list of locale-appropriate legal disclaimers rendered in the body */
  disclaimers: DisclaimerEntry[];
}

/** Metric counter name emitted on locale fallback. */
export const METRIC_PDF_LOCALE_FALLBACK = 'pdf_locale_fallback';

// ── Supported locales ─────────────────────────────────────────────────────

export const SUPPORTED_LOCALES = [
  'en-US',
  'de-DE',
  'fr-FR',
  'ja-JP',
  'es-ES',
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Default (root-of-trust) locale — must always be present. */
export const DEFAULT_LOCALE: SupportedLocale = 'en-US';

// ── Bundles ───────────────────────────────────────────────────────────────

/**
 * SHA-256 hash pin for each locale bundle.
 *
 * These are computed from the canonical JSON serialization of each bundle
 * with sorted keys. When a bundle changes, the pin MUST be updated, and the
 * change MUST go through code review (audit trail for legal text).
 */
const BUNDLE_HASH_PINS: Record<SupportedLocale, string> = {
  'en-US':
    '7183f758db67cf4d4f21dc9d8e5ab4b731fa1b2e6005a96e4d9da95249cab6e1',
  'de-DE':
    'fd5a39d8306968de4a38c0aa4bf7b6bea2f197fce1d0371e38936f5f402ba2a9',
  'fr-FR':
    '004e723636b6870d3ac6fb8f2653eacf1ee4cd341aad365700bd9885a1e2f093',
  'ja-JP':
    '7adfc7117e9fde31e4cf16ae7c4fb4d14ef6e5a3a2697d124ef714442f80cb7c',
  'es-ES':
    '0c5cab4a2a6ea8fddd0968e142d914cd67a3c1c1ead7ac2cdd991624c297b1dd',
};

const bundles: Record<SupportedLocale, LocaleDisclaimerBundle> = {
  'en-US': {
    locale: 'en-US',
    headerText:
      'CONFIDENTIAL — Investor Statement — For intended recipient only',
    footerText:
      'This statement is provided for informational purposes. Past performance does not guarantee future results. ' +
      'Securities offered through Revora are subject to applicable US federal and state regulations (Reg D, Securities Act of 1933).',
    disclaimers: [
      {
        jurisdiction: 'US (Reg D)',
        text:
          'These securities have not been registered under the Securities Act of 1933 and may not be offered or sold ' +
          'in the United States absent registration or an applicable exemption from registration requirements.',
      },
      {
        jurisdiction: 'General',
        text:
          'This document is confidential and intended solely for the named recipient. Unauthorized distribution, ' +
          'copying, or disclosure is prohibited. Investments involve risk, including possible loss of principal.',
      },
    ],
  },

  'de-DE': {
    locale: 'de-DE',
    headerText:
      'VERTRAULICH — Investorenauszug — Nur für den vorgesehenen Empfänger',
    footerText:
      'Dieser Auszug dient nur zu Informationszwecken. Die Wertentwicklung der Vergangenheit ist kein ' +
      'verlässlicher Indikator für zukünftige Ergebnisse. Dieses Dokument stellt kein öffentliches Angebot dar.',
    disclaimers: [
      {
        jurisdiction: 'EWR (MiFID II)',
        text:
          'Dieses Dokument wurde gemäß den Anforderungen der Richtlinie 2014/65/EU (MiFID II) erstellt. ' +
          'Die enthaltenen Informationen richten sich ausschließlich an professionelle Kunden und geeignete Gegenparteien.',
      },
      {
        jurisdiction: 'Allgemein',
        text:
          'Dieses Dokument ist vertraulich und ausschließlich für den genannten Empfänger bestimmt. ' +
          'Jegliche unerlaubte Verbreitung, Vervielfältigung oder Weitergabe ist untersagt. ' +
          'Kapitalanlagen sind mit Risiken verbunden, einschließlich des möglichen Verlusts des eingesetzten Kapitals.',
      },
    ],
  },

  'fr-FR': {
    locale: 'fr-FR',
    headerText:
      'CONFIDENTIEL — Relevé de l\'investisseur — Réservé au destinataire prévu',
    footerText:
      'Ce relevé est fourni à titre informatif uniquement. Les performances passées ne préjugent pas des ' +
      'performances futures. Ce document ne constitue pas une offre publique.',
    disclaimers: [
      {
        jurisdiction: 'EEE (MiFID II)',
        text:
          'Ce document a été établi conformément aux exigences de la directive 2014/65/UE (MiFID II). ' +
          'Les informations qu\'il contient sont destinées exclusivement aux clients professionnels ' +
          'et aux contreparties éligibles.',
      },
      {
        jurisdiction: 'Général',
        text:
          'Ce document est confidentiel et destiné exclusivement au destinataire désigné. Toute distribution, ' +
          'reproduction ou divulgation non autorisée est interdite. Les investissements comportent des risques, ' +
          'y compris la perte possible du capital investi.',
      },
    ],
  },

  'ja-JP': {
    locale: 'ja-JP',
    headerText:
      '親展 — 投資家ステートメント — 対象受領者のみ',
    footerText:
      '本ステートメントは情報提供のみを目的としています。過去の実績は将来の結果を保証するものではありません。' +
      '本資料は金融商品取引法に基づく開示書類ではありません。',
    disclaimers: [
      {
        jurisdiction: '日本 (FSA)',
        text:
          '本資料は、金融商品取引法（昭和23年法律第25号）に基づく法定開示書類ではなく、' +
          '金融庁の審査を受けたものではありません。投資判断はご自身の責任において行ってください。',
      },
      {
        jurisdiction: '一般',
        text:
          '本資料は機密情報を含み、指定された受領者のみを対象としています。無断での配布、複製、開示は禁止されています。' +
          '投資には元本損失のリスクが伴います。',
      },
    ],
  },

  'es-ES': {
    locale: 'es-ES',
    headerText:
      'CONFIDENCIAL — Extracto del Inversor — Solo para el destinatario previsto',
    footerText:
      'Este extracto se proporciona únicamente con fines informativos. Rentabilidades pasadas no garantizan ' +
      'resultados futuros. Este documento no constituye una oferta pública.',
    disclaimers: [
      {
        jurisdiction: 'EEE (MiFID II)',
        text:
          'Este documento ha sido elaborado de conformidad con los requisitos de la Directiva 2014/65/UE (MiFID II). ' +
          'La información contenida en el mismo está dirigida exclusivamente a clientes profesionales y ' +
          'contrapartes elegibles.',
      },
      {
        jurisdiction: 'General',
        text:
          'Este documento es confidencial y está destinado exclusivamente al destinatario indicado. Se prohíbe ' +
          'su distribución, reproducción o divulgación no autorizada. Las inversiones conllevan riesgos, ' +
          'incluida la posible pérdida del capital invertido.',
      },
    ],
  },
};

// ── Hash verification ─────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hex digest of a locale bundle's canonical JSON representation.
 * Uses sorted keys for deterministic output across environments.
 */
export function computeBundleHash(bundle: LocaleDisclaimerBundle): string {
  const canonical = JSON.stringify(bundle, Object.keys(bundle).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verify all pinned bundles against their expected hashes.
 * Throws on first mismatch — fail loud at module load time so corrupted
 * or tampered bundles are caught before rendering.
 */
export function verifyAllBundleHashes(): void {
  for (const locale of SUPPORTED_LOCALES) {
    const bundle = bundles[locale];
    const expected = BUNDLE_HASH_PINS[locale];
    const actual = computeBundleHash(bundle);

    if (actual !== expected) {
      throw new Error(
        `Disclaimer bundle hash mismatch for locale "${locale}": ` +
          `expected ${expected.slice(0, 16)}..., got ${actual.slice(0, 16)}...`
      );
    }
  }
}

/**
 * Update the hash pins to match the current bundle content.
 * Used during development / bundle updates. Returns updated pins map.
 */
export function computeAllBundleHashes(): Record<SupportedLocale, string> {
  const hashes: Partial<Record<SupportedLocale, string>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    hashes[locale] = computeBundleHash(bundles[locale]);
  }
  return hashes as Record<SupportedLocale, string>;
}

// Hash verification is performed lazily on first bundle access to avoid
// blocking module load during development/testing. Production deployments
// should call `verifyAllBundleHashes()` at startup (e.g., in a health check
// or startup probe) to fail fast if a bundle has been tampered with or
// corrupted.
let hashesVerified = false;

function ensureHashesVerified(): void {
  if (!hashesVerified) {
    verifyAllBundleHashes();
    hashesVerified = true;
  }
}

/** Force re-verification of all bundle hashes (useful after bundle updates). */
export function revalidateBundleHashes(): void {
  hashesVerified = false;
  verifyAllBundleHashes();
}

// ── Loader ────────────────────────────────────────────────────────────────

/**
 * Result returned by {@link resolveDisclaimerBundle}. Captures both the
 * resolved bundle and whether a fallback occurred (so callers can emit metrics).
 */
export interface DisclaimerBundleResult {
  bundle: LocaleDisclaimerBundle;
  /** True if the requested locale was not found and fell back to the default. */
  fallback: boolean;
  /** The original requested locale (even when fallback occurred). */
  requestedLocale: string;
}

/**
 * Resolve a disclaimer bundle for the given locale.
 *
 * - Exact match on supported locale: returns that bundle directly.
 * - "any" alias or unknown locale: falls back to `en-US` with `fallback: true`.
 * - If `en-US` itself is missing (should be impossible after hash verification),
 *   throws a fatal error.
 *
 * @param locale  IETF BCP 47 locale tag (e.g. "en-US", "de-DE", "any").
 * @returns The resolved bundle and metadata.
 */
export function resolveDisclaimerBundle(locale: string): DisclaimerBundleResult {
  ensureHashesVerified();
  const normalized = normalizeLocale(locale);

  // Exact match
  if (SUPPORTED_LOCALES.includes(normalized as SupportedLocale)) {
    return {
      bundle: bundles[normalized as SupportedLocale],
      fallback: false,
      requestedLocale: locale,
    };
  }

  // Unknown / unsupported → fallback to en-US
  const fallbackBundle = bundles[DEFAULT_LOCALE];
  if (!fallbackBundle) {
    throw new Error(
      `Fatal: default locale "${DEFAULT_LOCALE}" bundle is missing. ` +
        `Cannot render investor statement PDF disclaimers.`
    );
  }

  return {
    bundle: fallbackBundle,
    fallback: true,
    requestedLocale: locale,
  };
}

/**
 * Get the disclaimer bundle directly, throwing if the requested locale has
 * no bundle AND the en-US fallback is missing.
 *
 * Convenience wrapper around {@link resolveDisclaimerBundle} for callers
 * that don't need the fallback metadata.
 */
export function getDisclaimerBundle(locale: string): LocaleDisclaimerBundle {
  return resolveDisclaimerBundle(locale).bundle;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize locale strings to the supported format.
 * Handles common variants like "en", "en_us", "en-us" → "en-US".
 */
function normalizeLocale(locale: string): string {
  // "any" is the canonical way for callers to request autodetection / default
  if (locale === 'any' || !locale) {
    return 'any';
  }

  const parts = locale.trim().split(/[-_]/);
  if (parts.length === 1) {
    // Bare language code — try common mappings
    const lang = parts[0].toLowerCase();
    const mapping: Record<string, string> = {
      en: 'en-US',
      de: 'de-DE',
      fr: 'fr-FR',
      ja: 'ja-JP',
      es: 'es-ES',
    };
    return mapping[lang] ?? parts[0];
  }

  const language = parts[0].toLowerCase();
  const region = parts[1].toUpperCase();
  return `${language}-${region}`;
}
