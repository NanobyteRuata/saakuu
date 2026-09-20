/**
 * The workspace a book opens on, per user and per book (docs/06 Phase 10 and 13, decision 60).
 * Kept in `localStorage`, which can be empty, cleared or throw (private windows, blocked site data),
 * so every read is wrapped and the caller renders the computed default on its own.
 */

/**
 * The four workspaces in working order. Settings is a gear rather than a peer (decision 68), so it is
 * not somewhere a book can land; `""` is the Result Table at the book root.
 */
export const BOOK_WORKSPACES = ["", "templates", "documents", "review"] as const;
export type BookWorkspace = (typeof BOOK_WORKSPACES)[number];

/**
 * Phase 13 renamed this key from `.tab`. The old value could be `settings`, which is no longer a
 * destination, and a rename retires every stored one without a migration: the cost is a single
 * forgotten preference per user, and the computed default is already the safe path.
 */
const workspaceKey = (userId: string, bookId: string) => `saakuu.book.${userId}.${bookId}.workspace`;
/** Redirecting once per browser session per book keeps the back button out of a loop. */
const landedKey = (userId: string, bookId: string) => `saakuu.book.${userId}.${bookId}.landed`;

function isWorkspace(value: string | null): value is BookWorkspace {
  return value !== null && (BOOK_WORKSPACES as readonly string[]).includes(value);
}

export function readLastWorkspace(userId: string, bookId: string): BookWorkspace | null {
  try {
    const stored = window.localStorage.getItem(workspaceKey(userId, bookId));
    return isWorkspace(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeLastWorkspace(userId: string, bookId: string, workspace: BookWorkspace): void {
  try {
    window.localStorage.setItem(workspaceKey(userId, bookId), workspace);
  } catch {
    // Remembering the workspace is a convenience; the default still works.
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
