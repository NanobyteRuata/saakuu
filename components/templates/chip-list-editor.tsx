"use client";

import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";

type Props = {
  id?: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  disabled?: boolean;
  lang?: string;
};

/** Ordered list of short strings (anchors, choices). Enter adds; Backspace on an empty input removes the last. */
export function ChipListEditor({ id, label, values, onChange, placeholder, disabled = false, lang }: Props) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((value) => (
        <span key={value} lang={lang} className="bg-secondary font-value inline-flex items-center gap-1 rounded px-2 py-0.5 text-sm">
          {value}
          <button
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => onChange(values.filter((v) => v !== value))}
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Input
        id={id}
        aria-label={label}
        lang={lang}
        placeholder={placeholder}
        className="font-value h-8 min-w-48 flex-1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        disabled={disabled}
      />
    </div>
  );
}
