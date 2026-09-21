"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";

import { getJson } from "@/lib/api-client";
import { claimLanding, readLastWorkspace } from "@/lib/books/landing-workspace";
import type { ResumePoint } from "@/lib/review/types";

/** Long enough to be read after the redirect settles; it is an offer, not a notice. */
const RESUME_OFFER_MS = 15_000;

/**
 * Sends the operator to the workspace they last used in this book (docs/06 Phase 10 and 13,
 * decision 60), or to Templates while the book has none — the Result Table stays empty longest for a
 * new user and is the slowest to load for a returning one.
 *
 * Mounted on the Result Table, which is where a book link lands. It runs at most once per browser
 * session per book, so the back button and the Result Table itself still work, and it renders
 * nothing: the Result Table is the computed default and is already on screen when storage is empty
 * or unreadable.
 *
 * It is also where a half-reviewed book **offers the document review stopped in** (docs/06 Phase 19). A toast rather
 * than a banner, because a banner would spend the photo's pixels in every workspace for something read once. Landing on
 * Review needs no offer: Review itself resumes there.
 */
export function LandingWorkspaceRedirect({ bookId, userId, templateCount }: { bookId: string; userId: string; templateCount: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!claimLanding(userId, bookId)) return;
    // A stored workspace is a choice the operator made, including choosing the Result Table: only a
    // book that has never been opened falls back to Templates.
    const target = readLastWorkspace(userId, bookId) ?? (templateCount === 0 ? "templates" : "");
    if (target !== "") router.replace(`/books/${bookId}/${target}`);
    // A book with no templates has no rows, so `resumePoint` would say null anyway; this only saves the request.
    if (target === "review" || templateCount === 0) return;
    void getJson<ResumePoint | null>(`/api/books/${bookId}/review-resume`).then((result) => {
      // Failing to find the stopping point costs nothing: the nav's Review link still resumes there.
      if (!result.ok || !result.data) return;
      const { rowId, documentLabel } = result.data;
      toast(documentLabel ? `You stopped reviewing in ${documentLabel}.` : "You stopped partway through review.", {
        id: `resume-${bookId}`,
        duration: RESUME_OFFER_MS,
        action: { label: "Resume review", onClick: () => router.push(`/books/${bookId}/review?row=${rowId}`) },
      });
    });
  }, [bookId, userId, templateCount, router]);
  return null;
}
