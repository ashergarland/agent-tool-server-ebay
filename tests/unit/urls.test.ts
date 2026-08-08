import { describe, expect, it } from 'vitest';
import {
  isLegacyItemId,
  parseBrowseItemId,
  parseItemReference,
  resolveMarketplace,
  toBrowseItemId,
} from '../../src/provider/ebay/urls.js';
import { marketplaceForHost } from '../../src/provider/ebay/marketplaces.js';

const ID = '407111131587';

const expectBadRequest = (input: string): void => {
  expect(() => parseItemReference(input)).toThrowError(
    expect.objectContaining({ code: 'bad_request' }) as unknown,
  );
};

describe('parseItemReference — bare identifiers', () => {
  it('accepts a bare numeric legacy item id', () => {
    const reference = parseItemReference(ID);
    expect(reference).toMatchObject({
      kind: 'listing',
      legacyItemId: ID,
      itemId: `v1|${ID}|0`,
      legacyVariationId: undefined,
      marketplaceId: undefined,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseItemReference(`  ${ID}\n`).legacyItemId).toBe(ID);
  });

  it('accepts a Browse API item id', () => {
    expect(parseItemReference(`v1|${ID}|0`)).toMatchObject({
      itemId: `v1|${ID}|0`,
      legacyItemId: ID,
      legacyVariationId: undefined,
    });
  });

  it('preserves a real variation id from a Browse item id', () => {
    expect(parseItemReference(`v1|${ID}|123456`)).toMatchObject({
      itemId: `v1|${ID}|123456`,
      legacyItemId: ID,
      legacyVariationId: '123456',
    });
  });

  it('normalises the zero variation sentinel away', () => {
    expect(parseBrowseItemId(`v1|${ID}|000`)?.legacyVariationId).toBeUndefined();
  });

  it('accepts a future Browse id version prefix', () => {
    expect(parseItemReference(`v2|${ID}|0`).legacyItemId).toBe(ID);
  });

  it('rejects a numeric id that is too short to be an item id', () => {
    expectBadRequest('12345');
  });

  it('rejects a numeric id that is too long to be an item id', () => {
    expectBadRequest('1234567890123456789');
  });
});

describe('parseItemReference — listing URLs', () => {
  it('parses a plain /itm/<id> URL', () => {
    expect(parseItemReference(`https://www.ebay.com/itm/${ID}`)).toMatchObject({
      legacyItemId: ID,
      marketplaceId: 'EBAY_US',
      sourceUrl: `https://www.ebay.com/itm/${ID}`,
    });
  });

  it('parses a slugged /itm/<slug>/<id> URL', () => {
    const url = `https://www.ebay.com/itm/Sony-PlayStation-2-Slim-Console/${ID}`;
    expect(parseItemReference(url).legacyItemId).toBe(ID);
  });

  it('parses a multi-segment slug', () => {
    const url = `https://www.ebay.com/itm/retro/consoles/ps2/${ID}`;
    expect(parseItemReference(url).legacyItemId).toBe(ID);
  });

  it('tolerates a trailing slash', () => {
    expect(parseItemReference(`https://www.ebay.com/itm/${ID}/`).legacyItemId).toBe(ID);
  });

  it('ignores query strings and tracking parameters', () => {
    const url = `https://www.ebay.com/itm/${ID}?hash=item5ec4e5b103:g:AAAA&_trkparms=x&epid=99`;
    expect(parseItemReference(url).legacyItemId).toBe(ID);
  });

  it('ignores URL fragments', () => {
    expect(parseItemReference(`https://www.ebay.com/itm/${ID}#description`).legacyItemId).toBe(ID);
  });

  it('reads the variation id from the var query parameter', () => {
    const url = `https://www.ebay.com/itm/${ID}?var=660123456789`;
    expect(parseItemReference(url)).toMatchObject({
      legacyItemId: ID,
      legacyVariationId: '660123456789',
      itemId: `v1|${ID}|660123456789`,
    });
  });

  it('discards var=0', () => {
    expect(parseItemReference(`https://www.ebay.com/itm/${ID}?var=0`).legacyVariationId).toBe(
      undefined,
    );
  });

  it('accepts a URL with no scheme', () => {
    expect(parseItemReference(`www.ebay.com/itm/${ID}`).legacyItemId).toBe(ID);
  });

  it('accepts http URLs', () => {
    expect(parseItemReference(`http://www.ebay.com/itm/${ID}`).marketplaceId).toBe('EBAY_US');
  });

  it('accepts the mobile host', () => {
    expect(parseItemReference(`https://m.ebay.com/itm/${ID}`)).toMatchObject({
      legacyItemId: ID,
      marketplaceId: 'EBAY_US',
    });
  });

  it('accepts a bare ebay.com host with no www', () => {
    expect(parseItemReference(`https://ebay.com/itm/${ID}`).marketplaceId).toBe('EBAY_US');
  });

  it('normalises a slugged URL to its canonical form', () => {
    const url = `https://www.ebay.co.uk/itm/Sega-Saturn/${ID}?hash=abc`;
    expect(parseItemReference(url).sourceUrl).toBe(`https://www.ebay.co.uk/itm/${ID}`);
  });

  it('keeps the raw input for diagnostics', () => {
    const url = `https://www.ebay.com/itm/${ID}?hash=abc`;
    expect(parseItemReference(url).raw).toBe(url);
  });
});

describe('parseItemReference — legacy ISAPI links', () => {
  it('reads the item id from the item query parameter', () => {
    const url = `https://cgi.ebay.com/ws/eBayISAPI.dll?ViewItem&item=${ID}`;
    expect(parseItemReference(url)).toMatchObject({ legacyItemId: ID, marketplaceId: 'EBAY_US' });
  });

  it('reads the itemId query parameter', () => {
    const url = `https://www.ebay.com/ulk/itm?itemId=${ID}`;
    expect(parseItemReference(url).legacyItemId).toBe(ID);
  });

  it('rejects an ISAPI link with no item id', () => {
    expectBadRequest('https://cgi.ebay.com/ws/eBayISAPI.dll?ViewItem');
  });
});

describe('parseItemReference — country hosts map to marketplaces', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['www.ebay.com', 'EBAY_US'],
    ['www.ebay.co.uk', 'EBAY_GB'],
    ['www.ebay.de', 'EBAY_DE'],
    ['www.ebay.fr', 'EBAY_FR'],
    ['www.ebay.it', 'EBAY_IT'],
    ['www.ebay.es', 'EBAY_ES'],
    ['www.ebay.ca', 'EBAY_CA'],
    ['www.ebay.com.au', 'EBAY_AU'],
    ['www.ebay.at', 'EBAY_AT'],
    ['www.ebay.ch', 'EBAY_CH'],
    ['www.ebay.ie', 'EBAY_IE'],
    ['www.ebay.nl', 'EBAY_NL'],
    ['www.ebay.pl', 'EBAY_PL'],
    ['www.ebay.be', 'EBAY_BE'],
    ['www.ebay.com.hk', 'EBAY_HK'],
    ['www.ebay.com.sg', 'EBAY_SG'],
  ];

  for (const [host, marketplaceId] of cases) {
    it(`maps ${host} to ${marketplaceId}`, () => {
      expect(parseItemReference(`https://${host}/itm/${ID}`).marketplaceId).toBe(marketplaceId);
    });
  }

  it('maps ebaymotors.com to the US marketplace', () => {
    expect(marketplaceForHost('www.ebaymotors.com')).toBe('EBAY_US');
  });

  it('does not match a lookalike host', () => {
    expect(marketplaceForHost('notebay.com')).toBeUndefined();
  });

  it('does not match an attacker-controlled subdomain suffix', () => {
    expect(marketplaceForHost('ebay.com.evil.example')).toBeUndefined();
  });

  it('rejects a non-eBay host outright', () => {
    expectBadRequest(`https://www.example.com/itm/${ID}`);
  });
});

describe('parseItemReference — product pages', () => {
  it('recognises a /p/<epid> product page as a product reference', () => {
    expect(parseItemReference('https://www.ebay.com/p/2296658')).toMatchObject({
      kind: 'product',
      epid: '2296658',
      legacyItemId: undefined,
    });
  });

  it('recognises a slugged product page', () => {
    expect(parseItemReference('https://www.ebay.com/p/Sony-PlayStation-2/2296658')).toMatchObject({
      kind: 'product',
      epid: '2296658',
    });
  });
});

describe('parseItemReference — invalid input', () => {
  it('rejects a non-string', () => {
    expect(() => parseItemReference(undefined)).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
    expect(() => parseItemReference(42)).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('rejects an empty or whitespace-only string', () => {
    expectBadRequest('');
    expectBadRequest('   ');
  });

  it('rejects an over-long string', () => {
    expectBadRequest(`https://www.ebay.com/itm/${'a'.repeat(3000)}`);
  });

  it('rejects free text', () => {
    expectBadRequest('please find me a playstation 2');
  });

  it('rejects a non-http scheme', () => {
    expectBadRequest(`javascript:alert(1)//www.ebay.com/itm/${ID}`);
  });

  it('rejects an eBay URL that is not a listing', () => {
    expectBadRequest('https://www.ebay.com/sch/i.html?_nkw=playstation+2');
  });

  it('rejects an eBay search URL even though it contains digits', () => {
    expectBadRequest('https://www.ebay.com/b/Video-Games/139973');
  });
});

describe('item id helpers', () => {
  it('builds a Browse item id with the no-variation sentinel', () => {
    expect(toBrowseItemId(ID)).toBe(`v1|${ID}|0`);
    expect(toBrowseItemId(ID, '99')).toBe(`v1|${ID}|99`);
  });

  it('round-trips a Browse item id', () => {
    expect(parseBrowseItemId(toBrowseItemId(ID, '99'))).toEqual({
      legacyItemId: ID,
      legacyVariationId: '99',
    });
  });

  it('returns undefined for a non Browse item id', () => {
    expect(parseBrowseItemId(ID)).toBeUndefined();
    expect(parseBrowseItemId('v1|abc|0')).toBeUndefined();
    expect(parseBrowseItemId(`v1|${ID}`)).toBeUndefined();
  });

  it('identifies legacy item ids', () => {
    expect(isLegacyItemId(ID)).toBe(true);
    expect(isLegacyItemId(' 123456789 ')).toBe(true);
    expect(isLegacyItemId('12345')).toBe(false);
    expect(isLegacyItemId('v1|123456789012|0')).toBe(false);
  });
});

describe('resolveMarketplace', () => {
  const reference = parseItemReference(`https://www.ebay.co.uk/itm/${ID}`);

  it('prefers an explicit caller choice', () => {
    expect(resolveMarketplace('EBAY_DE', reference, 'EBAY_US')).toBe('EBAY_DE');
  });

  it('falls back to the marketplace implied by the URL', () => {
    expect(resolveMarketplace(undefined, reference, 'EBAY_US')).toBe('EBAY_GB');
  });

  it('falls back to the connector default for a bare item id', () => {
    expect(resolveMarketplace(undefined, parseItemReference(ID), 'EBAY_AU')).toBe('EBAY_AU');
  });

  it('falls back to the connector default with no reference at all', () => {
    expect(resolveMarketplace(undefined, undefined, 'EBAY_US')).toBe('EBAY_US');
  });
});
