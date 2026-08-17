import { describe, expect, it } from 'vitest';
import { parseAccountDeletionNotification } from '../../../src/compliance/ebay-account-deletion/schema.js';
import { isAppError } from '../../../src/errors.js';
import { validNotificationBody } from '../../helpers/ebay-signature.js';

const rejectionStatus = (body: unknown): number => {
  try {
    parseAccountDeletionNotification(body);
  } catch (error) {
    if (isAppError(error)) return error.status;
    throw error;
  }
  throw new Error('expected a rejection');
};

describe('MARKETPLACE_ACCOUNT_DELETION payload validation', () => {
  it('accepts the payload eBay documents', () => {
    const parsed = parseAccountDeletionNotification(validNotificationBody());
    expect(parsed.metadata.topic).toBe('MARKETPLACE_ACCOUNT_DELETION');
    expect(parsed.notification.publishAttemptCount).toBe(1);
  });

  it('tolerates additional fields so a schema evolution is not treated as an outage', () => {
    const body = validNotificationBody();
    (body['metadata'] as Record<string, unknown>)['futureField'] = 'value';
    (body['notification'] as Record<string, unknown>)['anotherField'] = { nested: true };

    expect(() => parseAccountDeletionNotification(body)).not.toThrow();
  });

  it('tolerates a missing optional deprecated flag', () => {
    const body = validNotificationBody();
    delete (body['metadata'] as Record<string, unknown>)['deprecated'];

    expect(() => parseAccountDeletionNotification(body)).not.toThrow();
  });

  it.each([
    ['a non-object', 'not a notification'],
    ['null', null],
    ['an empty object', {}],
    ['an array', []],
  ])('rejects %s with a bounded 400', (_label, body) => {
    expect(rejectionStatus(body)).toBe(400);
  });

  it.each(['metadata', 'notification'])('rejects a payload without %s', (field) => {
    const body = validNotificationBody();
    delete body[field];
    expect(rejectionStatus(body)).toBe(400);
  });

  it.each(['notificationId', 'eventDate', 'publishDate', 'publishAttemptCount', 'data'])(
    'rejects a notification without %s',
    (field) => {
      const body = validNotificationBody();
      delete (body['notification'] as Record<string, unknown>)[field];
      expect(rejectionStatus(body)).toBe(400);
    },
  );

  it.each(['username', 'userId', 'eiasToken'])(
    'rejects account-deletion data without %s',
    (field) => {
      const body = validNotificationBody();
      const data = (body['notification'] as Record<string, unknown>)['data'] as Record<
        string,
        unknown
      >;
      delete data[field];
      expect(rejectionStatus(body)).toBe(400);
    },
  );

  it('rejects a non-timestamp eventDate', () => {
    const body = validNotificationBody();
    (body['notification'] as Record<string, unknown>)['eventDate'] = 'not-a-date';
    expect(rejectionStatus(body)).toBe(400);
  });

  it('rejects an unbounded identifier', () => {
    const body = validNotificationBody();
    const data = (body['notification'] as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >;
    data['userId'] = 'x'.repeat(300);
    expect(rejectionStatus(body)).toBe(400);
  });

  it('rejects a different topic deliberately rather than silently acknowledging it', () => {
    const body = validNotificationBody();
    (body['metadata'] as Record<string, unknown>)['topic'] = 'ITEM_SOLD';

    try {
      parseAccountDeletionNotification(body);
      expect.unreachable('expected a rejection');
    } catch (error) {
      expect(isAppError(error) && error.status).toBe(400);
      expect(isAppError(error) && error.message).toContain('MARKETPLACE_ACCOUNT_DELETION');
    }
  });

  it('never echoes account identifiers back in a validation failure', () => {
    const body = validNotificationBody();
    (body['notification'] as Record<string, unknown>)['publishAttemptCount'] = 'one';

    try {
      parseAccountDeletionNotification(body);
      expect.unreachable('expected a rejection');
    } catch (error) {
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialised).not.toContain('example_user');
      expect(serialised).not.toContain('example-user-id');
      expect(serialised).not.toContain('example-eias-token');
    }
  });
});
