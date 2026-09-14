import Link from "next/link";

import type { SessionUser } from "@/lib/auth/session";

import { NavLink } from "./nav-link";
import { UserMenu } from "./user-menu";

export function TopBar({ user }: { user: SessionUser }) {
  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      {/* Height comes from --top-bar-height so sticky elements below can offset by it. */}
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
