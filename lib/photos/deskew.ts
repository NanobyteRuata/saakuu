import { MAX_DESKEW_DEGREES } from "./transform";

/**
 * Skew estimate by projection profile: text lines and ruled lines are horizontal when the page is
 * straight, so the row histogram of dark pixels is sharpest (highest variance) at the right angle.
 * Pure: takes a greyscale buffer (1 byte per pixel), returns the correction in degrees to add to the
 * transform's `deskew`. Coarse pass then fine pass keeps it to ~100 angle evaluations.
 */
export function estimateSkew(pixels: Uint8Array, width: number, height: number): number {
  const threshold = otsuThreshold(pixels);
  const xs: number[] = [];
  const ys: number[] = [];
  // Ignore a 3% margin: page edges and shadows dominate otherwise.
  const mx = Math.floor(width * 0.03);
  const my = Math.floor(height * 0.03);
  for (let y = my; y < height - my; y++) {
    for (let x = mx; x < width - mx; x++) {
      if ((pixels[y * width + x] ?? 255) < threshold) {
        xs.push(x - width / 2);
        ys.push(y - height / 2);
      }
    }
  }
  if (xs.length < 50) return 0;
  // Very dark images (photographed background) carry no line signal worth trusting.
  if (xs.length > 0.6 * width * height) return 0;

  const diagonal = Math.ceil(Math.hypot(width, height));
  const bins = new Float64Array(diagonal * 2 + 1);
  const score = (degrees: number) => {
    const rad = (degrees * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] ?? 0;
      const y = ys[i] ?? 0;
      const row = Math.round(y * cos - x * sin) + diagonal;
      bins[row] = (bins[row] ?? 0) + 1;
    }
    let sumSq = 0;
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i] ?? 0;
      sumSq += b * b;
    }
    return sumSq;
  };

  let best = 0;
  let bestScore = -1;
  for (let a = -MAX_DESKEW_DEGREES; a <= MAX_DESKEW_DEGREES; a += 1) {
    const s = score(a);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  const coarse = best;
  for (let a = coarse - 1; a <= coarse + 1 + 1e-9; a += 0.1) {
    const s = score(a);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  // A point rotated by -θ straightens a page skewed by θ; the render rotates by +deskew.
  const correction = -Math.round(best * 10) / 10;
  return Math.max(-MAX_DESKEW_DEGREES, Math.min(MAX_DESKEW_DEGREES, correction === 0 ? 0 : correction));
}

function otsuThreshold(pixels: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i] ?? 0;
    hist[v] = (hist[v] ?? 0) + 1;
  }
  const total = pixels.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * (hist[i] ?? 0);
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t] ?? 0;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * (hist[t] ?? 0);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}
