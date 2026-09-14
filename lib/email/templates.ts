import type { EmailMessage } from "./sender";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function layout(paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#171717;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>` +
      `<p style="margin:0 0 16px;color:#737373;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(action.url)}</p>`
    : "";
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#171717;max-width:520px">${body}${button}<p style="color:#737373;font-size:13px">SaaKuu</p></div>`;
}

export function verifyEmailMessage(to: string, url: string): EmailMessage {
  const lines = [
    "Confirm your email address to finish setting up your SaaKuu account.",
    "This link expires in 24 hours. If you didn't create an account, you can ignore this email.",
  ];
  return {
    to,
    subject: "Confirm your email for SaaKuu",
    text: `${lines[0]}\n\n${url}\n\n${lines[1]}`,
    html: layout(lines, { label: "Confirm email", url }),
  };
}

export function resetPasswordMessage(to: string, url: string): EmailMessage {
  const lines = [
    "Someone asked to reset the password for your SaaKuu account.",
    "This link works once and expires in 1 hour. Resetting signs you out everywhere. If you didn't ask for this, you can ignore this email.",
  ];
  return {
    to,
    subject: "Reset your SaaKuu password",
    text: `${lines[0]}\n\n${url}\n\n${lines[1]}`,
    html: layout(lines, { label: "Reset password", url }),
  };
}

export function accountExistsMessage(to: string, signInUrl: string, forgotUrl: string): EmailMessage {
  const lines = [
    "Someone tried to create a SaaKuu account with this email address, but you already have one.",
    `Sign in at ${signInUrl}. If you don't know your password, reset it at ${forgotUrl}.`,
    "If this wasn't you, you can ignore this email.",
  ];
  return {
    to,
    subject: "You already have a SaaKuu account",
    text: lines.join("\n\n"),
    html: layout(lines),
  };
}
