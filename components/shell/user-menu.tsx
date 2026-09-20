"use client";

import { KeyRound, LogOut } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { SignOutDialog } from "./sign-out-dialog";

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : source.slice(0, 2);
  return letters.toUpperCase();
}

export function UserMenu({ email, name, image }: { email: string; name: string | null; image: string | null }) {
  const [signOutOpen, setSignOutOpen] = useState(false);

  return (
    <>
      {/* Non-modal so the confirmation dialog can take focus cleanly after the menu closes. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          className="focus-visible:ring-ring/50 rounded-full outline-none focus-visible:ring-[3px]"
          aria-label="Account menu"
        >
          <Avatar>
            {image ? <AvatarImage src={image} alt="" referrerPolicy="no-referrer" /> : null}
            <AvatarFallback>{initials(name, email)}</AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            {name ? <span className="truncate">{name}</span> : null}
            <span className="text-muted-foreground truncate text-xs font-normal">{email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/account">
              <KeyRound />
              Account and AI key
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSignOutOpen(true)}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} email={email} />
    </>
  );
}
