import type { EmailMessage, EmailSender } from "./sender";

/**
 * In-memory outbox for `EMAIL_TRANSPORT=test`. Lets E2E tests read verification and reset
 * links without a real mailbox. Exposed only via `/api/test/outbox`, which 404s outside test.
 */

type StoredMessage = EmailMessage & { sentAt: string };

const globalForOutbox = globalThis as unknown as { saakuuOutbox?: StoredMessage[] };
const outbox = (globalForOutbox.saakuuOutbox ??= []);

const MAX_MESSAGES = 200;

export const outboxSender: EmailSender = {
  async send(message) {
    outbox.push({ ...message, sentAt: new Date().toISOString() });
    if (outbox.length > MAX_MESSAGES) outbox.splice(0, outbox.length - MAX_MESSAGES);
  },
};

export function latestMessageTo(to: string): StoredMessage | null {
  const address = to.trim().toLowerCase();
  for (let i = outbox.length - 1; i >= 0; i--) {
    const message = outbox[i];
    if (message && message.to === address) return message;
  }
  return null;
}
