import Link from "next/link";

import type { SessionUser } from "@/lib/auth/session";

import { NavLink } from "./nav-link";
import { UserMenu } from "./user-menu";

export function TopBar({ user }: { user: SessionUser }) {
  return (
    // The shell is a fixed-height column and the page never scrolls (docs/05 §0), so the bar is a
    // plain row rather than a sticky one, and nothing below it offsets by its height any more.
    <header className="bg-background z-40 shrink-0 border-b">
      <div className="flex h-(--top-bar-height) items-center justify-between px-4 sm:px-6">
        <Link href="/books" className="text-lg font-semibold tracking-tight">
          SaaKuu
        </Link>
        <div className="flex items-center gap-4">
          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink href="/books">Books</NavLink>
          </nav>
          <UserMenu email={user.email} name={user.name} image={user.image} />
        </div>
      </div>
    </header>
  );
}
