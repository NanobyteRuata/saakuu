import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AiKeyForm } from "@/components/account/ai-key-form";
import { aiAccount } from "@/lib/account/service";
import { formatMoney } from "@/lib/ai/models";
import { requireSessionUserId } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Account · SaaKuu" };

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-xl border p-5">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** The account area (Phase 12): the AI key this user reads with, and what that reading has cost. */
export default async function AccountPage() {
  const userId = await requireSessionUserId();
  const account = await aiAccount(userId);
  const { spend } = account;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="text-muted-foreground text-sm">
          Settings for you, not for one book.{" "}
          <Link href="/books" className="underline">
            Back to books
          </Link>
          .
        </p>
      </div>

      <Section
        title="AI key"
        description="Which key pays for reading your pages. Your own key puts extraction on your own account; without one, the server's key is used where it has been set up."
      >
        <AiKeyForm account={account} />
      </Section>

      <Section title="Reading so far" description="Everything your books have read, priced at the model's list prices. An estimate, not a bill.">
        {spend.runs === 0 && spend.unpricedRuns === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing has been read yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-sm">
              <span className="text-2xl font-semibold">{formatMoney(spend.costUsd)}</span>{" "}
              <span className="text-muted-foreground">
                across {spend.documents.toLocaleString("en-US")} {spend.documents === 1 ? "document" : "documents"} and{" "}
                {spend.runs.toLocaleString("en-US")} {spend.runs === 1 ? "reading" : "readings"}.
              </span>
            </p>
            {spend.unpricedRuns > 0 ? (
              <p className="text-muted-foreground text-xs">
                {spend.unpricedRuns.toLocaleString("en-US")} further {spend.unpricedRuns === 1 ? "reading is" : "readings are"} not included:
                {spend.unpricedRuns === 1 ? " it ran" : " they ran"} on a model this version has no price for.
              </p>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
