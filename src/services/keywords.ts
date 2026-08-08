/**
 * Turning an eBay listing title into a search query.
 *
 * eBay titles are keyword-stuffed by sellers ("RARE!! L@@K Sony PlayStation 2 Slim Console FREE
 * SHIP NR"). Feeding one back into search verbatim returns almost nothing, because eBay matches
 * every token. This module strips the marketing noise, keeps the tokens that actually identify
 * the product, and bounds the result so the query stays broad enough to return comparables.
 */

/** Generic English stop words plus eBay listing filler that carries no product meaning. */
const NOISE_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'best',
  'bin',
  'brand',
  'bundle',
  'buy',
  'by',
  'cheap',
  'combined',
  'deal',
  'discount',
  'excellent',
  'fast',
  'for',
  'free',
  'from',
  'genuine',
  'great',
  'here',
  'htf',
  'in',
  'is',
  'it',
  'l@@k',
  'levels',
  'look',
  'lot',
  'must',
  'new',
  'nice',
  'no',
  'now',
  'nr',
  'of',
  'offer',
  'on',
  'or',
  'original',
  'perfect',
  'post',
  'price',
  'quick',
  'rare',
  'read',
  'reserve',
  'sale',
  'see',
  'sell',
  'ship',
  'shipping',
  'the',
  'to',
  'top',
  'uk',
  'us',
  'usa',
  'vgc',
  'view',
  'wow',
  'with',
  'wow!',
]);

/** Titles are cleaned of separators that eBay treats as noise before tokenising. */
const SEPARATORS = /[!?*"'’“”|(){}[\]<>~#@^_+=;:,./\\-]+/g;

const MAX_TOKENS = 8;
const MIN_TOKEN_LENGTH = 2;

/**
 * Extracts the meaningful tokens of a listing title, preserving their original order (which for
 * eBay titles usually runs brand -> model -> variant) and de-duplicating case-insensitively.
 */
export const titleKeywords = (title: string, maxTokens = MAX_TOKENS): readonly string[] => {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const rawToken of title.replace(SEPARATORS, ' ').split(/\s+/)) {
    const token = rawToken.trim();
    if (token.length === 0) continue;

    const lower = token.toLowerCase();
    if (NOISE_WORDS.has(lower)) continue;
    // Keep short tokens only when they are numeric-ish model markers such as "3" or "64".
    if (token.length < MIN_TOKEN_LENGTH && !/\d/.test(token)) continue;
    if (seen.has(lower)) continue;

    seen.add(lower);
    tokens.push(token);
    if (tokens.length >= maxTokens) break;
  }

  return tokens;
};

/** The item specifics that most reliably narrow a search to genuinely comparable listings. */
const IDENTIFYING_ASPECTS = [
  'brand',
  'model',
  'platform',
  'video game series',
  'game name',
  'mpn',
  'manufacturer part number',
  'model number',
  'series',
  'type',
];

/**
 * Picks the aspect values worth adding to a generated search query. Values that already appear in
 * the title tokens are skipped so the query does not become needlessly narrow.
 */
export const identifyingAspectValues = (
  aspects: readonly { readonly name: string; readonly value: string }[],
  alreadyUsed: readonly string[],
  maxValues = 2,
): readonly string[] => {
  const used = new Set(alreadyUsed.map((token) => token.toLowerCase()));
  const picked: string[] = [];

  for (const aspectName of IDENTIFYING_ASPECTS) {
    const match = aspects.find((aspect) => aspect.name.toLowerCase() === aspectName);
    if (!match) continue;
    const value = match.value.trim();
    if (value.length === 0 || value.length > 40) continue;
    const lower = value.toLowerCase();
    if (used.has(lower)) continue;
    // Skip values whose words are all already in the query.
    if (lower.split(/\s+/).every((word) => used.has(word))) continue;

    used.add(lower);
    picked.push(value);
    if (picked.length >= maxValues) break;
  }

  return picked;
};

/** Joins query parts into the single `q` string the Browse API accepts, bounded to 100 chars. */
export const buildSearchQuery = (parts: readonly string[]): string =>
  parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
