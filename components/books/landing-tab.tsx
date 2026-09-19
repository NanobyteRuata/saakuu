"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { claimLanding, readLastTab } from "@/lib/books/landing-tab";

/**
 * Sends the operator to the tab they last used in this book (docs/06 Phase 10, decision 60), or to
 * Templates while the book has none — Table is the tab that stays empty longest for a new user and
 * the slowest to load for a returning one.
 *
 * Mounted on the Table tab, which is where a book link lands. It runs at most once per browser
 * session per book, so the back button and the Table tab itself still work, and it renders nothing:
 * the Table tab is the computed default and is already on screen when storage is empty or unreadable.
 */
export function LandingTabRedirect({ bookId, userId, templateCount }: { bookId: string; userId: string; templateCount: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!claimLanding(userId, bookId)) return;
    // A stored tab is a choice the operator made, including choosing Table: only a book that has
    // never been opened falls back to Templates.
    const target = readLastTab(userId, bookId) ?? (templateCount === 0 ? "templates" : "");
    if (target === "") return;
    router.replace(`/books/${bookId}/${target}`);
  }, [bookId, userId, templateCount, router]);
  return null;
}
