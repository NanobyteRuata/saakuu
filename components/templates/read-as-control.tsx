"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { pickOption } from "@/lib/books/labels";
import type { DateEra } from "@/lib/books/schemas";
import { READ_AS_HINTS, READ_AS_LABELS } from "@/lib/mappings/labels";
import { defaultSymbolMeaning, READ_AS_KINDS, readAsOfKind, type ReadAs } from "@/lib/mappings/read-as";
import { AGE_UNIT_HINTS, AGE_UNIT_LABELS, TWO_DIGIT_YEAR_LABELS, twoDigitYearHint } from "@/lib/templates/labels";
import { AGE_UNITS, MAX_MARK_SYMBOLS, TWO_DIGIT_YEAR_RULES, type MarkSymbols } from "@/lib/templates/schemas";

const MARK_MEANINGS = [
  { value: "true", label: "Yes / ticked" },
  { value: "false", label: "No / not given" },
  { value: "count", label: "Count the strokes" },
] as const;

type MarkMeaning = (typeof MARK_MEANINGS)[number]["value"];
type MarkRow = { symbol: string; meaning: MarkMeaning };

function rowsOf(readAs: ReadAs): MarkRow[] {
  if (readAs.kind !== "MARK") return [];
  return Object.entries(readAs.symbols).map(([symbol, v]) => ({ symbol, meaning: v === "count" ? "count" : v ? "true" : "false" }));
}

/** Rows still being typed (a blank symbol) stay on screen and are left out of what is saved. */
function symbolsOf(rows: MarkRow[]): MarkSymbols {
  return Object.fromEntries(rows.filter((r) => r.symbol.trim() !== "").map((r) => [r.symbol.trim(), r.meaning === "count" ? "count" : r.meaning === "true"]));
}

type Props = {
  /** Unique on the page: several sources can be open at once. */
  id: string;
  /** What the control is for, e.g. the field's name; used in labels for screen readers. */
  name: string;
  value: ReadAs;
  /** The field being read: its listed symbols and whether it has choices. Null when it was deleted. */
  field: { markSymbols: string[]; choices: string[] } | null;
  /** The book's date era: two-digit years are read in that era's century. */
  era: DateEra;
  lang: string | undefined;
  /** From ticks reads its fields as marks and nothing else. */
  marksOnly?: boolean;
  onChange: (value: ReadAs) => void;
};

/**
 * Read as (decision 86): how one field a mapping reads is converted before the mapping uses it. Free
 * to change: rows are rebuilt from what the AI already read.
 */
export function ReadAsControl({ id, name, value, field, era, lang, marksOnly = false, onChange }: Props) {
  const [rows, setRows] = useState(() => rowsOf(value));
  const [pivot, setPivot] = useState(value.kind === "DATE" && value.pivotYear !== null ? String(value.pivotYear) : "");

  const setMarks = (next: MarkRow[]) => {
    setRows(next);
    onChange({ kind: "MARK", symbols: symbolsOf(next) });
  };
  const setKind = (kind: ReadAs["kind"]) => {
    const next = readAsOfKind(kind, { markSymbols: field?.markSymbols ?? [] });
    setRows(rowsOf(next));
    setPivot("");
    onChange(next);
  };
  const pivotNumber = (text: string): number | null => {
    const n = Number(text.trim());
    return text.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
  };

  const kinds = READ_AS_KINDS.filter((k) => k !== "CHOICE" || value.kind === "CHOICE" || (field?.choices.length ?? 0) > 0);
  const listed = rows.map((r) => r.symbol.trim());
  const notSet = (field?.markSymbols ?? []).filter((s) => !listed.includes(s));

  return (
    <div className="border-muted flex flex-col gap-2 border-l-2 pl-3">
      {marksOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id} className="shrink-0 font-normal">
            Read as
          </Label>
          <Select value={value.kind} onValueChange={(v) => setKind(pickOption(READ_AS_KINDS, v) ?? value.kind)}>
            <SelectTrigger id={id} className="w-44" aria-label={`Read ${name} as`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {READ_AS_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {value.kind !== "DATE" && value.kind !== "AGE" && value.kind !== "MARK" ? <p className="text-muted-foreground text-xs">{READ_AS_HINTS[value.kind]}</p> : null}

      {value.kind === "DATE" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-two-digit-year`} className="font-normal">
            Dates written with a two-digit year
          </Label>
          <Select
            value={value.twoDigitYear}
            onValueChange={(v) => {
              const twoDigitYear = pickOption(TWO_DIGIT_YEAR_RULES, v) ?? value.twoDigitYear;
              const text = twoDigitYear === "PIVOT" && pivot.trim() === "" ? "50" : pivot;
              setPivot(text);
              onChange({ kind: "DATE", twoDigitYear, pivotYear: twoDigitYear === "PIVOT" ? pivotNumber(text) : null });
            }}
          >
            <SelectTrigger id={`${id}-two-digit-year`} className="w-full" aria-label={`Two-digit years in ${name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TWO_DIGIT_YEAR_RULES.map((rule) => (
                <SelectItem key={rule} value={rule}>
                  {TWO_DIGIT_YEAR_LABELS[rule]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {value.twoDigitYear === "PIVOT" ? (
            <div className="flex items-center gap-2">
              <Label htmlFor={`${id}-pivot-year`} className="font-normal">
                Split at
              </Label>
              <Input
                id={`${id}-pivot-year`}
                className="w-20"
                inputMode="numeric"
                placeholder="50"
                value={pivot}
                onChange={(e) => {
                  setPivot(e.target.value);
                  onChange({ ...value, pivotYear: pivotNumber(e.target.value) });
                }}
              />
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">{twoDigitYearHint(value.twoDigitYear, era, value.pivotYear)}</p>
        </div>
      ) : null}

      {value.kind === "AGE" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-age-unit`} className="font-normal">
            Show age as
          </Label>
          <Select value={value.unit} onValueChange={(v) => onChange({ kind: "AGE", unit: pickOption(AGE_UNITS, v) ?? value.unit })}>
            <SelectTrigger id={`${id}-age-unit`} className="w-full" aria-label={`Show the age in ${name} as`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGE_UNITS.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {AGE_UNIT_LABELS[unit]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{AGE_UNIT_HINTS[value.unit]}</p>
        </div>
      ) : null}

      {value.kind === "MARK" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm">What the marks in {name} mean</legend>
          {rows.length === 0 ? <p className="text-muted-foreground text-xs">No symbols set, so anything written in the box counts as ticked.</p> : null}
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={`Mark ${i + 1} symbol in ${name}`}
                lang={lang}
                className="font-value w-20"
                placeholder="✓"
                value={row.symbol}
                onChange={(e) => setMarks(rows.map((r, j) => (j === i ? { ...r, symbol: e.target.value } : r)))}
              />
              <Select
                value={row.meaning}
                onValueChange={(v) => {
                  const meaning = MARK_MEANINGS.find((o) => o.value === v)?.value;
                  if (meaning) setMarks(rows.map((r, j) => (j === i ? { ...r, meaning } : r)));
                }}
              >
                <SelectTrigger aria-label={`Mark ${i + 1} meaning in ${name}`} className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MARK_MEANINGS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove mark ${i + 1} in ${name}`} onClick={() => setMarks(rows.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            {rows.length < MAX_MARK_SYMBOLS ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { symbol: "", meaning: "true" }])}>
                <Plus />
                Add a symbol
              </Button>
            ) : null}
            {notSet.slice(0, MAX_MARK_SYMBOLS - rows.length).map((symbol) => (
              <Button key={symbol} type="button" variant="ghost" size="sm" onClick={() => setMarks([...rows, { symbol, meaning: defaultSymbolMeaning(symbol) ? "true" : "false" }])}>
                <Plus />
                <span lang={lang} className="font-value">
                  {symbol}
                </span>
              </Button>
            ))}
          </div>
          {notSet.length > 0 && rows.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {notSet.length === 1 ? "A symbol" : "Symbols"} listed on the Fields tab {notSet.length === 1 ? "has" : "have"} no meaning here yet. Until{" "}
              {notSet.length === 1 ? "it does" : "they do"}, a cell holding {notSet.length === 1 ? "it" : "one"} is flagged.
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}
