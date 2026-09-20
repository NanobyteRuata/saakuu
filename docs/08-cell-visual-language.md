# 08 — Cell State Visual Language

This replaces the state table in `docs/05-ui-screens.md` §12. It governs the output
table, row review, and (later) column sweep — the same cell must look the same
everywhere.

## 1. The core problem

Cell state is not one enum. It is **four independent dimensions** that co-occur. A
single cell can simultaneously be human-edited, contain an illegible marker, fail a
validation rule, and be unreviewed. Encoding these as one colour scale produces a
Christmas tree and an unreadable table.

The solution is to give each dimension **its own visual channel**, so they stack
without competing.

| Dimension | Question it answers | Channel | Mutually exclusive? |
|---|---|---|---|
| **Authorship** | Where did this value come from? | Cell background tint | Yes (by precedence) |
| **Semantics** | What does the value actually say? | Text rendering | Yes |
| **Attention** | Does this need my action? | Left edge bar | Yes (by precedence) |
| **Progress** | Have I checked it? | Top-right corner dot | Binary |

Four channels, four dimensions, no collisions. Hover, focus, and selection are
transient overlays on a fifth channel (outline/ring) and always win visually because
they are momentary.

---

## 2. Channel A — Authorship (background tint)

Answers "who put this here". Resolved by precedence, top wins.

| State | Condition | Background | Extra cue |
|---|---|---|---|
| **Human** | `isEdited = true`, or the value came from a `MANUAL`-mode field | `--cell-human` | none (this is the common human state; keep it quiet) |
| **Inherited** | `inherited = true` (resolved from a ditto mark) | `--cell-inherited` | `⇡` glyph before the value, muted, 10px |
| **Awaiting entry** | mapped from a `SKIP`-mode field and still empty | `--cell-awaiting` diagonal hatch | none |
| **Extracted** | default | transparent | none |

Human-edited and manually-entered values are deliberately **not** distinguished from
each other. Both are "a person is responsible for this", which is the only distinction
that changes how much you trust the cell. Merging them removes a state for free.

The inherited glyph matters more than the tint: it tells the operator that no human
and no camera ever saw this value on the page in that position — it was copied from
above by a rule. That is a meaningfully different kind of data.

**Tint intensity:** these cover entire cells across a dense grid, so they must be at
the threshold of perceptibility — roughly 6–8% alpha. If a tint is obvious on a single
cell, it is far too strong across 3,000 rows.

---

## 3. Channel B — Semantics (text rendering)

Answers "what does this say". The five `ValueState`s must be visually distinct from
each other and from an ordinary short value, because collapsing them destroys meaning
the operator needs.

| State | Rendering |
|---|---|
| `OK` | the value, normal weight, full contrast |
| `EMPTY` | nothing at all |
| `DASH` | `–` in muted colour, centred |
| `NOT_APPLICABLE` | `n/a` in muted colour, small caps, centred |
| `ILLEGIBLE` | `?` on a muted circular chip, centred, with tooltip "Could not be read" |

Muted styling is deliberate: these are all "there is no usable value here" outcomes,
and they should recede relative to real data while staying mutually distinguishable on
close inspection. The operator scanning a column for real values should have their eye
skip past all four.

**Low confidence** also lives on this channel, as a **dotted underline** beneath the
value text — not on the attention channel. It is far too common (potentially 40% of
cells) to justify an edge bar; a table where 40% of cells shout is a table where
nothing shouts.

Low confidence is shown **only when** `confidence < DEFAULT_CONFIDENCE_THRESHOLD` (0.75) **and**
the cell is neither edited nor reviewed. It was configurable per book until Phase 14, which deleted
the setting rather than defaulting it: a knob with no feedback loop over the model's own
self-reported confidence (decision 77). Once a human
has touched or confirmed the cell, the model's self-assessment is irrelevant and the
underline disappears. This single rule removes most of the noise.

---

## 4. Channel C — Attention (left edge bar)

A 3px bar on the cell's left edge. Answers "does this need action". Resolved by
precedence, top wins — **one bar only, ever**.

| Priority | State | Colour token | Meaning |
|---|---|---|---|
| 1 | **Validation error** | `--attn-error` | Breaks the data. Rule violation with severity ERROR. |
| 2 | **Disagreement** | `--attn-disagree` | Re-extraction contradicts a human edit. Rare and specifically requires a decision. |
| 3 | **Validation warning** | `--attn-warn` | Rule violation with severity WARNING. |
| — | none | transparent | nothing needed |

Error outranks disagreement because an error blocks clean export while a disagreement
is merely a question. Both outrank a warning.

The bar carries a tooltip with the specific message ("Date is after 2030",
"Extracted value is 47, you entered 42"). Disagreement cells additionally show a small
chevron that opens an inline extracted-vs-current comparison with `Keep mine` /
`Use extracted` actions.

Because only one bar shows at a time, a cell with both an error and a disagreement
must surface the second in the tooltip text. Never stack bars.

---

## 5. Channel D — Progress (corner dot)

A 5px dot in the top-right corner when `isReviewed = true`. Muted, low contrast —
roughly `--fg` at 30%.

Reviewed is marked rather than unreviewed for a simple reason: a freshly extracted
table is 100% unreviewed, and highlighting every cell in it communicates nothing. As
review progresses, the dots fill in and the remaining gaps are exactly what the eye
should find. The signal grows as the work shrinks.

If `disagreement` is raised on a cell that was already reviewed, **clear
`isReviewed`** so the dot disappears and the cell resurfaces. A reviewed cell whose
underlying data changed is no longer reviewed.

---

## 6. Channel E — Interaction (transient, always wins)

| State | Rendering |
|---|---|
| Row hover | row-wide background lift, `--row-hover`, plus the provenance chip appears |
| Cell hover | 1px inset outline, `--border` |
| Cell focus | 2px ring, `--accent`, plus the source region is boxed in the photo panel |
| Editing | 2px ring `--accent` + raised background `--bg` + shadow |
| Selected range | `--accent` at 10%, overlaying the authorship tint |

These are momentary, so they may fully override Channel A. Focus must never be
ambiguous: exactly one cell has the accent ring at any time.

---

## 7. Resolution algorithm

Implement once, in `lib/table/cellState.ts`. Every surface calls it; no component
computes state inline.

```ts
type CellVisual = {
  authorship: "extracted" | "human" | "inherited" | "awaiting";
  semantics:  "ok" | "empty" | "dash" | "na" | "illegible";
  lowConfidence: boolean;
  attention:  "none" | "warning" | "disagreement" | "error";
  reviewed:   boolean;
};

export function resolveCellVisual(cell: Cell): CellVisual {
  // A — authorship, by precedence
  const authorship =
    cell.isEdited || cell.isManual        ? "human"
    : cell.inherited                      ? "inherited"
    : cell.isSkipSourced && !cell.currentValue ? "awaiting"
    : "extracted";

  // B — semantics
  const semantics =
    cell.state === "ILLEGIBLE"      ? "illegible"
    : cell.state === "DASH"         ? "dash"
    : cell.state === "NOT_APPLICABLE" ? "na"
    : !cell.currentValue            ? "empty"
    : "ok";

  // B — low confidence, suppressed once a human is involved
  const lowConfidence =
    cell.confidence != null &&
    cell.confidence < DEFAULT_CONFIDENCE_THRESHOLD &&
    !cell.isEdited &&
    !cell.isReviewed;

  // C — attention, by precedence
  const attention =
    cell.validationState === "ERROR" ? "error"
    : cell.disagreement              ? "disagreement"
    : cell.validationState === "WARNING" ? "warning"
    : "none";

  return { authorship, semantics, lowConfidence, attention, reviewed: cell.isReviewed };
}
```

Pure, trivially testable, and the golden-file tests should cover every collision pair.

---

## 8. Design tokens

```css
:root {
  /* A — authorship */
  --cell-human:     rgb(59 130 246 / 0.07);   /* cool = a person did this */
  --cell-inherited: rgb(120 120 128 / 0.05);  /* neutral = derived by rule */
  --cell-awaiting:  repeating-linear-gradient(45deg,
                      transparent 0 6px,
                      rgb(120 120 128 / 0.06) 6px 7px);

  /* B — semantics */
  --value-muted:    rgb(100 100 110);
  --confidence-underline: rgb(217 119 6 / 0.55);

  /* C — attention */
  --attn-error:     rgb(220 38 38);
  --attn-disagree:  rgb(139 92 246);
  --attn-warn:      rgb(217 119 6);

  /* D — progress */
  --reviewed-dot:   rgb(60 60 70 / 0.30);

  /* E — interaction */
  --row-hover:      rgb(120 120 128 / 0.04);
  --accent:         rgb(37 99 235);
}

.dark {
  --cell-human:     rgb(96 165 250 / 0.10);
  --cell-inherited: rgb(160 160 175 / 0.06);
  --cell-awaiting:  repeating-linear-gradient(45deg,
                      transparent 0 6px,
                      rgb(160 160 175 / 0.07) 6px 7px);
  --value-muted:    rgb(150 150 165);
  --confidence-underline: rgb(251 191 36 / 0.55);
  --attn-error:     rgb(248 113 113);
  --attn-disagree:  rgb(167 139 250);
  --attn-warn:      rgb(251 191 36);
  --reviewed-dot:   rgb(220 220 235 / 0.30);
  --row-hover:      rgb(200 200 215 / 0.05);
  --accent:         rgb(96 165 250);
}
```

Dark-mode attention colours are lightened rather than reused — saturated reds on dark
backgrounds vibrate badly at 3px widths.

---

## 9. Rules that keep this usable

1. **Never colour alone.** Every coloured state has a shape, glyph, or position cue.
   The three attention colours are also distinguishable by tooltip and, for
   disagreement, by the chevron affordance.
2. **One bar, one tint, one dot.** If a cell would show two of anything in one channel,
   the resolution function is wrong.
3. **Quiet by default.** Ordinary extracted values get zero decoration. In a healthy
   table most cells should be completely plain.
4. **Human states are quiet too.** Edited cells get a whisper of tint, not a highlight.
   By the end of a review session most of the table may be edited; that must not look
   alarming.
5. **The loud states are rare by construction.** Error, disagreement, and awaiting-entry
   should each be a small minority of cells. If any of them is common, the problem is
   the mapping or the rules, not the styling — and the table saying so is useful.
6. **Row hover never obscures cell state.** The row lift is weaker than every
   authorship tint.

---

## 10. Legend

The table toolbar carries a `?` that opens a legend panel showing every state with a
one-line explanation. Operators will use this product for hours a day and will learn
it, but they need a reference on day one, and it doubles as the spec's own test: if a
state cannot be explained in one line, it should not exist.

Legend order mirrors the channels: authorship, then semantics, then attention, then
progress.

---

## 11. Density

- Default row height 32px, compact 28px, comfortable 40px — a toolbar toggle.
- Values are `font-variant-numeric: tabular-nums` so digit columns align vertically.
  This matters enormously for scanning a column of handwritten numbers.
- Burmese values render in `"Noto Sans Myanmar"` with a slightly larger line-height;
  Burmese glyphs need more vertical room than Latin at the same font size.
- Truncate with ellipsis, full value in a tooltip and in the review panel. Never wrap
  in the grid.
