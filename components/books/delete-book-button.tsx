"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { DeleteBooksDialog } from "./delete-books-dialog";

export function DeleteBookButton({ book }: { book: { id: string; name: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete book
      </Button>
      <DeleteBooksDialog
        open={open}
        onOpenChange={setOpen}
        books={[book]}
        onDeleted={() => {
          router.push("/books");
          router.refresh();
        }}
      />
    </>
  );
}
