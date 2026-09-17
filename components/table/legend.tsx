"use client";

import { CircleHelp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function Swatch({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <span className={cn("relative inline-flex h-6 w-12 shrink-0 items-center justify-center rounded-sm border text-xs", className)}>{children}</span>;
}

function Item({ swatch, label, text }: { swatch: React.ReactNode; label: string; text: string }) {
  return (
    <li className="flex items-center gap-3">
      {swatch}
      <span className="text-sm">
        <span className="font-medium">{label}</span> <span className="text-muted-foreground">{text}</span>
      </span>
    </li>
  );
}

function Bar({ kind }: { kind: "error" | "disagreement" | "warning" }) {
  return <span className={cn("absolute inset-y-0 left-0 w-[3px]", `cell-bar-${kind}`)} />;
}

/** What every cell state means, one line each, in channel order (docs/08 §10). */
export function TableLegend() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="What the cell styles mean" title="What the cell styles mean">
          <CircleHelp className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-96 overflow-y-auto">
        <h3 className="text-sm font-semibold">Who put the value there</h3>
        <ul className="mt-2 flex flex-col gap-2">
          <Item swatch={<Swatch>42</Swatch>} label="Extracted" text="read by the AI, untouched." />
          <Item swatch={<Swatch className="cell-authorship-human">42</Swatch>} label="Human" text="you edited it, or it was typed once per document (Manual)." />
          <Item
            swatch={
              <Swatch className="cell-authorship-inherited">
                <span className="mr-0.5 text-[10px] text-(--value-muted)">⇡</span>42
              </Swatch>
            }
            label="Inherited"
            text="copied from the row above because of a ditto mark."
          />
          <Item swatch={<Swatch className="cell-authorship-awaiting" />} label="Awaiting entry" text="a Skip field: nobody reads it, it's waiting for you." />
        </ul>
        <h3 className="mt-4 text-sm font-semibold">What the paper says</h3>
        <ul className="mt-2 flex flex-col gap-2">
          <Item swatch={<Swatch />} label="Empty" text="nothing written." />
          <Item swatch={<Swatch className="text-(--value-muted)">–</Swatch>} label="Dash" text="a dash was written." />
          <Item swatch={<Swatch className="text-(--value-muted) [font-variant-caps:all-small-caps]">n/a</Swatch>} label="Not applicable" text="written as N/A." />
          <Item
            swatch={
              <Swatch>
                <span className="bg-muted inline-flex size-4 items-center justify-center rounded-full text-[10px] font-semibold text-(--value-muted)">?</span>
              </Swatch>
            }
            label="Illegible"
            text="could not be read."
          />
          <Item swatch={<Swatch><span className="cell-low-confidence">42</span></Swatch>} label="Uncertain" text="the reading was unsure; gone once you edit or review it." />
        </ul>
        <h3 className="mt-4 text-sm font-semibold">Needs your attention</h3>
        <ul className="mt-2 flex flex-col gap-2">
          <Item swatch={<Swatch><Bar kind="error" />42</Swatch>} label="Error" text="breaks a rule or the column type. Hover the bar for why." />
          <Item swatch={<Swatch><Bar kind="disagreement" />42</Swatch>} label="Disagreement" text="a new reading differs from your edit. Open the arrow to choose." />
          <Item swatch={<Swatch><Bar kind="warning" />42</Swatch>} label="Check" text="a warning worth a look." />
        </ul>
        <h3 className="mt-4 text-sm font-semibold">Progress</h3>
        <ul className="mt-2 flex flex-col gap-2">
          <Item
            swatch={
              <Swatch>
                <span className="absolute top-1 right-1 size-[5px] rounded-full bg-(--reviewed-dot)" />
                42
              </Swatch>
            }
            label="Reviewed"
            text="someone checked this cell."
          />
        </ul>
      </PopoverContent>
    </Popover>
  );
}
