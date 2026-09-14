import { Resend } from "resend";

import type { Env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";

import type { EmailSender } from "./sender";

export function createResendSender(env: Env): EmailSender {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when EMAIL_TRANSPORT=resend");
  }
  const client = new Resend(env.RESEND_API_KEY);
  return {
    async send(message) {
      const { error } = await client.emails.send({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      if (error) {
        log.error("resend send failed", undefined, { to: message.to, subject: message.subject, resendError: error });
        throw new AppError("INTERNAL", "We couldn't send the email right now. Try again in a moment.");
      }
    },
  };
}
