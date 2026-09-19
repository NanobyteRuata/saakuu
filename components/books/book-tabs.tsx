"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { writeLastTab, type BookTabSegment } from "@/lib/books/landing-tab";
import { cn } from "@/lib/utils";

const TABS: { label: string; segment: BookTabSegment }[] = [
  { label: "Table", segment: "" },
  { label: "Templates", segment: "templates" },
  { label: "Documents", segment: "documents" },
  { label: "Settings", segment: "settings" },
];

export function BookTabs({ bookId, userId }: { bookId: string; userId: string }) {
  const pathname = usePathname();
  const root = `/books/${bookId}`;
  return (
    <nav aria-label="Book sections" className="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)]">
      {TABS.map(({ label, segment }) => {
        const href = segment ? `${root}/${segment}` : root;
        const active = segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === root;
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            // Written before navigating, so landing on the Table tab by choice is not redirected away.
            onClick={() => writeLastTab(userId, bookId, segment)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              active ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
