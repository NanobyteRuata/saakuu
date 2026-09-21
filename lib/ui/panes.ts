/**
 * The one number every layout yields to (docs/05 §0, decision 70).
 *
 * Burmese handwriting at 400px is guesswork, so the pane holding the photo carries a floor and
 * everything else gives way to it. Review has obeyed this since Phase 13; the template workspace
 * joined it in Phase 15, which is why the number moved out of `row-review.tsx` and into one place.
 */
export const PHOTO_MIN_PX = 560;
