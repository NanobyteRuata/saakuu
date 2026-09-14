"use client";

import { useFormStatus } from "react-dom";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/lib/auth/actions";

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}

/**
 * Sign-out confirmation. The confirm button is a plain submit (not AlertDialogAction) so the
 * dialog stays open with a pending state until the server redirects.
 */
export function SignOutDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out of SaaKuu?</AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;ll be signed out as {email} on this device. Your saved work is not affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form action={signOutAction}>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Confirm />
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
