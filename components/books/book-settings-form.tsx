"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AI_MODELS } from "@/lib/ai/models";
import { patchJson } from "@/lib/api-client";
import { DATE_ERA_LABELS, NUMERAL_SYSTEM_LABELS, pickOption } from "@/lib/books/labels";
import { DATE_ERAS, NUMERAL_SYSTEMS } from "@/lib/books/schemas";
import type { BookSettings } from "@/lib/books/service";
import { labelSchema } from "@/lib/validation";

const MODEL_IDS = AI_MODELS.map((m) => m.id);

export function BookSettingsForm({ book }: { book: BookSettings }) {
  const router = useRouter();
  const [name, setName] = useState(book.name);
  const [defaultModel, setDefaultModel] = useState(book.defaultModel);
  const [numeralSystem, setNumeralSystem] = useState(book.numeralSystem);
  const [dateEra, setDateEra] = useState(book.dateEra);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dirty =
    name.trim() !== book.name ||
    defaultModel !== book.defaultModel ||
    numeralSystem !== book.numeralSystem ||
    dateEra !== book.dateEra;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!labelSchema.safeParse(name).success) {
      setError("A book needs a name (up to 200 characters).");
      return;
    }
    setPending(true);
    const result = await patchJson<BookSettings>(`/api/books/${book.id}`, {
      name: name.trim(),
      defaultModel,
      numeralSystem,
      dateEra,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    toast.success("Settings saved.");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor="settings-name">Book name</Label>
        <Input id="settings-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-model">Default AI model</Label>
        <Select value={defaultModel} onValueChange={(v) => setDefaultModel(pickOption(MODEL_IDS, v) ?? defaultModel)}>
          <SelectTrigger id="settings-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AI_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="hidden sm:block" />
      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-numerals">Numeral system</Label>
        <Select value={numeralSystem} onValueChange={(v) => setNumeralSystem(pickOption(NUMERAL_SYSTEMS, v) ?? numeralSystem)}>
          <SelectTrigger id="settings-numerals" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NUMERAL_SYSTEMS.map((n) => (
              <SelectItem key={n} value={n}>
                {NUMERAL_SYSTEM_LABELS[n]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-era">Date era</Label>
        <Select value={dateEra} onValueChange={(v) => setDateEra(pickOption(DATE_ERAS, v) ?? dateEra)}>
          <SelectTrigger id="settings-era" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_ERAS.map((era) => (
              <SelectItem key={era} value={era}>
                {DATE_ERA_LABELS[era]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-muted-foreground text-sm sm:col-span-2">
        Numeral system and era are used when converting values after extraction. The AI always transcribes exactly
        what is written.
      </p>
      {error ? (
        <div className="sm:col-span-2">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
