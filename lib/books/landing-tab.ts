/**
 * The tab a book opens on, per user and per book (docs/06 Phase 10, decision 60). Kept in
 * `localStorage`, which can be empty, cleared or throw (private windows, blocked site data), so every
 * read is wrapped and the caller renders the computed default on its own.
 */

export const BOOK_TABS = ["", "templates", "documents", "settings"] as const;
export type BookTabSegment = (typeof BOOK_TABS)[number];

const tabKey = (userId: string, bookId: string) => `saakuu.book.${userId}.${bookId}.tab`;
/** Redirecting once per browser session per book keeps the back button out of a loop. */
const landedKey = (userId: string, bookId: string) => `saakuu.book.${userId}.${bookId}.landed`;

function isTab(value: string | null): value is BookTabSegment {
  return value !== null && (BOOK_TABS as readonly string[]).includes(value);
}

export function readLastTab(userId: string, bookId: string): BookTabSegment | null {
  try {
    const stored = window.localStorage.getItem(tabKey(userId, bookId));
    return isTab(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeLastTab(userId: string, bookId: string, segment: BookTabSegment): void {
  try {
    window.localStorage.setItem(tabKey(userId, bookId), segment);
  } catch {
    // Remembering the tab is a convenience; the default tab still works.
  }
}

/** True the first time this user opens the book in this browser session, and false every time after. */
export function claimLanding(userId: string, bookId: string): boolean {
  try {
    if (window.sessionStorage.getItem(landedKey(userId, bookId)) !== null) return false;
    window.sessionStorage.setItem(landedKey(userId, bookId), "1");
    return true;
  } catch {
    return false;
  }
}
