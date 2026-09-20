"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteJson, putJson } from "@/lib/api-client";
import { saveAiKeySchema } from "@/lib/account/schemas";
import type { AiAccount } from "@/lib/account/service";

/**
 * Bring-your-own Gemini key (Phase 12, decision 54). The key is shown back only as its last four
 * characters, because the server keeps it encrypted and never decrypts it towards the browser.
 */
export function AiKeyForm({ account }: { account: AiAccount }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "remove" | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = saveAiKeySchema.safeParse({ key });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Paste your API key.");
      return;
    }
    setError(null);
    setPending("save");
    const result = await putJson<{ hint: string }>("/api/account/ai-key", { key: parsed.data.key });
    setPending(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setKey("");
    toast.success("Your API key is saved.");
    router.refresh();
  }

  async function onRemove() {
    setError(null);
    setPending("remove");
    const result = await deleteJson<{ hint: null }>("/api/account/ai-key");
    setPending(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success(account.serverKey ? "Key removed. Reading now uses this server's key." : "Key removed.");
    router.refresh();
  }

  if (!account.canStoreKey) {
    return (
      <p className="text-muted-foreground text-sm">
        This server isn&apos;t set up to store personal API keys yet.{" "}
        {account.serverKey
          ? "Reading uses the server's own key in the meantime."
          : "Ask whoever runs SaaKuu to set one up before extracting anything."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {account.hint === null ? (
        <p className="text-sm">
          {account.serverKey
            ? "Reading currently uses this server's key. Save your own to put extraction on your own account instead."
            : "There's no key on this server, so nothing can be read until you save your own."}
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <p className="text-sm">
            Your own key is in use, ending <span className="font-value">····{account.hint}</span>.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRemove} disabled={pending !== null}>
            {pending === "remove" ? "Removing…" : "Remove"}
          </Button>
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <Label htmlFor="ai-key">{account.hint === null ? "Gemini API key" : "Replace with a different key"}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="max-w-md flex-1"
            placeholder="Paste your key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={pending !== null}
          />
          <Button type="submit" disabled={pending !== null || key.trim() === ""}>
            {pending === "save" ? "Saving…" : "Save key"}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Create one at{" "}
          <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">
            Google AI Studio
          </a>
          . It&apos;s stored encrypted and never shown again — only its last four characters.
        </p>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </form>
    </div>
  );
}
