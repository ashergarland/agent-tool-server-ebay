import { z } from 'zod';
import { badRequest } from '../../errors.js';

/**
 * Shape validation for eBay's `MARKETPLACE_ACCOUNT_DELETION` notification.
 *
 * Every field arrives from the public internet and is treated as untrusted. The objects are
 * deliberately *loose*: eBay documents that the payload may gain fields, and rejecting a
 * notification because it carries something new would look like an outage to eBay's delivery
 * pipeline. Only the fields the guide documents as always present are required, and each is
 * length-bounded so a hostile payload cannot be used as an amplification lever.
 *
 * https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion
 */

export const ACCOUNT_DELETION_TOPIC = 'MARKETPLACE_ACCOUNT_DELETION';

const boundedString = (max: number) => z.string().min(1).max(max);

/** ISO-8601 instants as published by eBay, e.g. `2021-03-19T20:43:59.462Z`. */
const isoTimestamp = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO-8601 timestamp');

/**
 * The identifiers eBay sends for the closed account. They are parsed so the payload can be
 * validated, but they are never logged, never persisted and never echoed back.
 */
const accountDeletionData = z
  .looseObject({
    username: boundedString(256),
    userId: boundedString(256),
    eiasToken: boundedString(1024),
  })
  .readonly();

export const accountDeletionNotificationSchema = z
  .looseObject({
    metadata: z.looseObject({
      topic: boundedString(128),
      schemaVersion: boundedString(32),
      deprecated: z.boolean().optional(),
    }),
    notification: z.looseObject({
      notificationId: boundedString(256),
      eventDate: isoTimestamp,
      publishDate: isoTimestamp,
      publishAttemptCount: z.number().int().min(0).max(10_000),
      data: accountDeletionData,
    }),
  })
  .readonly();

export type AccountDeletionNotification = z.infer<typeof accountDeletionNotificationSchema>;

/**
 * Parses an account-deletion notification, mapping every failure onto a bounded 400 whose message
 * describes the *structure* that was wrong and never echoes the submitted values back.
 */
export const parseAccountDeletionNotification = (body: unknown): AccountDeletionNotification => {
  const parsed = accountDeletionNotificationSchema.safeParse(body);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ]
      .slice(0, 10)
      .join(', ');
    throw badRequest('The notification payload did not match the eBay account-deletion schema.', {
      invalidFields: fields,
    });
  }

  if (parsed.data.metadata.topic !== ACCOUNT_DELETION_TOPIC) {
    // This callback is registered for exactly one topic. Anything else is a portal
    // misconfiguration, so it is surfaced loudly instead of being silently acknowledged.
    throw badRequest(`This endpoint only accepts ${ACCOUNT_DELETION_TOPIC} notifications.`, {
      expectedTopic: ACCOUNT_DELETION_TOPIC,
    });
  }

  return parsed.data;
};
