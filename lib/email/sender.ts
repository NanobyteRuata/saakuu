import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";

import { outboxSender } from "./outbox";
import { createResendSender } from "./resend";

export type EmailMessage = { to: string; subject: string; text: string; html: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Writes the message to the log instead of sending. For local development without a key. */
const logSender: EmailSender = {
  async send(message) {
    log.info("email (not sent: EMAIL_TRANSPORT=log)", { to: message.to, subject: message.subject, text: message.text });
  },
};

let cached: EmailSender | undefined;

export function getEmailSender(): EmailSender {
  if (cached) return cached;
  const env = getEnv();
  switch (env.EMAIL_TRANSPORT) {
    case "resend":
      cached = createResendSender(env);
      break;
    case "test":
      cached = outboxSender;
      break;
    case "log":
      cached = logSender;
      break;
  }
  return cached;
}
