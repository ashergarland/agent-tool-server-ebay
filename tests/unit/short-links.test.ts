import { describe, expect, it, vi } from 'vitest';
import { EbayShortLinkResolver, isEbayShortLink } from '../../src/provider/ebay/short-links.js';
import type { FetchLike } from '../../src/provider/ebay/oauth.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

const SHORT_LINK = 'https://ebay.io/m/tPMNkN';
const LISTING_URL =
  'https://www.ebay.com/itm/168601131927?var=&mkevt=1&mkcid=16&mkrid=711-127632-2357-0';

const redirect = (location: string, status = 301) => ({
  status,
  headers: { location },
});

describe('isEbayShortLink', () => {
  it('recognises the HTTPS mobile-share path on the exact ebay.io host', () => {
    expect(isEbayShortLink(SHORT_LINK)).toBe(true);
    expect(isEbayShortLink(' https://ebay.io/m/another_token-1 ')).toBe(true);
  });

  it.each([
    'http://ebay.io/m/tPMNkN',
    'https://www.ebay.io/m/tPMNkN',
    'https://ebay.io.evil.example/m/tPMNkN',
    'https://user:password@ebay.io/m/tPMNkN',
    'https://ebay.io:8443/m/tPMNkN',
    'https://ebay.io/not-a-mobile-share-link',
    'not a URL',
  ])('does not recognise unsafe or unrelated input %s', (input) => {
    expect(isEbayShortLink(input)).toBe(false);
  });
});

describe('EbayShortLinkResolver', () => {
  it('resolves the observed one-hop redirect without fetching the listing page', async () => {
    const fake = createFakeFetch([redirect(LISTING_URL)]);
    const resolver = new EbayShortLinkResolver({ fetchImpl: fake.fetchImpl });

    await expect(resolver.resolve(SHORT_LINK)).resolves.toBe(LISTING_URL);
    expect(fake.requests).toEqual([
      {
        url: SHORT_LINK,
        method: 'GET',
        headers: {},
        body: undefined,
      },
    ]);
  });

  it('leaves normal URLs and identifiers untouched without making a request', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const resolver = new EbayShortLinkResolver({ fetchImpl });

    await expect(resolver.resolve('https://www.ebay.com/itm/407111131587')).resolves.toBe(
      'https://www.ebay.com/itm/407111131587',
    );
    await expect(resolver.resolve('407111131587')).resolves.toBe('407111131587');
    await expect(resolver.resolve('v1|407111131587|0')).resolves.toBe('v1|407111131587|0');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a redirect to a non-eBay host without requesting that host', async () => {
    const fake = createFakeFetch([redirect('https://attacker.example/collect')]);
    const resolver = new EbayShortLinkResolver({ fetchImpl: fake.fetchImpl });

    await expect(resolver.resolve(SHORT_LINK)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining("unsupported host 'attacker.example'"),
    });
    expect(fake.requests.map((request) => request.url)).toEqual([SHORT_LINK]);
  });

  it('rejects a redirect loop', async () => {
    const fake = createFakeFetch([
      redirect('https://ebay.io/m/second'),
      redirect('/m/tPMNkN', 302),
    ]);
    const resolver = new EbayShortLinkResolver({ fetchImpl: fake.fetchImpl });

    await expect(resolver.resolve(SHORT_LINK)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('redirect loop'),
    });
    expect(fake.requests).toHaveLength(2);
  });

  it('rejects an excessive redirect chain', async () => {
    const fake = createFakeFetch([
      redirect('https://ebay.io/m/second'),
      redirect('https://ebay.io/m/third', 302),
    ]);
    const resolver = new EbayShortLinkResolver({
      fetchImpl: fake.fetchImpl,
      maxRedirects: 2,
    });

    await expect(resolver.resolve(SHORT_LINK)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('2-redirect safety limit'),
    });
    expect(fake.requests).toHaveLength(2);
  });

  it('rejects malformed redirect responses', async () => {
    const fake = createFakeFetch([{ status: 302 }]);
    const resolver = new EbayShortLinkResolver({ fetchImpl: fake.fetchImpl });

    await expect(resolver.resolve(SHORT_LINK)).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('without a Location header'),
    });
  });

  it('normalises a timeout as a retryable connector timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    const resolver = new EbayShortLinkResolver({ fetchImpl, timeoutMs: 5 });

    await expect(resolver.resolve(SHORT_LINK)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
      message: expect.stringContaining('mobile share link resolution'),
    });
  });

  it('normalises a network failure as a retryable upstream error', async () => {
    const fake = createFakeFetch([{ error: new Error('DNS lookup failed') }]);
    const resolver = new EbayShortLinkResolver({ fetchImpl: fake.fetchImpl });

    await expect(resolver.resolve(SHORT_LINK)).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: true,
      message: expect.stringContaining('could not reach eBay (DNS lookup failed)'),
    });
  });

  it('uses manual redirects and explicitly omits credentials and auth headers', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (_url, init) => {
      requestInit = init;
      return Promise.resolve(new Response('', { status: 301, headers: { location: LISTING_URL } }));
    };
    const resolver = new EbayShortLinkResolver({ fetchImpl });

    await resolver.resolve(SHORT_LINK);

    expect(requestInit?.redirect).toBe('manual');
    expect(requestInit?.credentials).toBe('omit');
    const headers = new Headers(requestInit?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('x-api-key')).toBe(false);
  });
});
