"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { patchJson } from "@/lib/api-client";
import { labelSchema } from "@/lib/validation";
import { cn } from "@/lib/utils";

/**
 * Book name in the workspace header; click to edit, Enter or blur saves, Escape cancels.
 * `className` sets the type size, because the frame's header is one line and every rem of it is a
 * rem the photo pane does not get (docs/05 §0).
 */
export function BookNameEditor({ bookId, name, className }: { bookId: string; name: string; className?: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function start() {
    setValue(name);
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (pending) return;
    const trimmed = value.trim();
    if (trimmed === name) {
      setEditing(false);
      return;
    }
    if (!labelSchema.safeParse(trimmed).success) {
      setError("A book needs a name (up to 200 characters).");
      return;
    }
    setPending(true);
    const result = await patchJson(`/api/books/${bookId}`, { name: trimmed });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    setEditing(false);
    router.refresh();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      setEditing(false);
      setError(null);
    }
  }

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <h1 className={cn("cursor-text truncate text-2xl font-semibold tracking-tight", className)} onClick={start}>
          {name}
        </h1>
        <Button variant="ghost" size="icon" aria-label="Rename book" onClick={start}>
          <Pencil />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label="New book name"
        className={cn("h-8 max-w-md text-xl font-semibold md:text-xl", className)}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void save()}
        disabled={pending}
        autoFocus
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
