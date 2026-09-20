"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { claimLanding, readLastWorkspace } from "@/lib/books/landing-workspace";

/**
 * Sends the operator to the workspace they last used in this book (docs/06 Phase 10 and 13,
 * decision 60), or to Templates while the book has none — the Result Table stays empty longest for a
 * new user and is the slowest to load for a returning one.
 *
 * Mounted on the Result Table, which is where a book link lands. It runs at most once per browser
 * session per book, so the back button and the Result Table itself still work, and it renders
 * nothing: the Result Table is the computed default and is already on screen when storage is empty
 * or unreadable.
 */
export function LandingWorkspaceRedirect({ bookId, userId, templateCount }: { bookId: string; userId: string; templateCount: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!claimLanding(userId, bookId)) return;
    // A stored workspace is a choice the operator made, including choosing the Result Table: only a
    // book that has never been opened falls back to Templates.
    const target = readLastWorkspace(userId, bookId) ?? (templateCount === 0 ? "templates" : "");
    if (target === "") return;
    router.replace(`/books/${bookId}/${target}`);
  }, [bookId, userId, templateCount, router]);
  return null;
}
