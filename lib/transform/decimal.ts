/**
 * Exact decimal arithmetic on BigInt. Numbers in the transform never round-trip through a float
 * (CLAUDE.md → Money/precision). Division is the only operation that rounds, to DIVISION_PLACES.
 */

export type Decimal = { units: bigint; scale: number };

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const FIVE = BigInt(5);
const TEN = BigInt(10);

export const DIVISION_PLACES = 12;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

export function parseDecimal(text: string): Decimal | null {
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/u.exec(text);
  if (!m) return null;
  const whole = m[2] ?? "";
  const frac = m[3] ?? "";
  if (whole === "" && frac === "") return null;
  return { units: BigInt(`${m[1] === "-" ? "-" : ""}${whole || "0"}${frac}`), scale: frac.length };
}

export function decimalFromInt(n: number): Decimal {
  return { units: BigInt(Math.trunc(n)), scale: 0 };
}

/** Canonical text: no trailing decimal zeros, no `-0`. */
export function formatDecimal(d: Decimal): string {
  let { units, scale } = d;
  while (scale > 0 && units % TEN === ZERO) {
    units /= TEN;
    scale--;
  }
  const negative = units < ZERO;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  const body = scale > 0 ? `${whole}.${frac}` : whole;
  return negative && units !== ZERO ? `-${body}` : body;
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

export function subDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

export function mulDecimal(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function compareDecimal(a: Decimal, b: Decimal): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZeroDecimal(d: Decimal): boolean {
  return d.units === ZERO;
}

/** a ÷ b rounded half away from zero to `places`; null when dividing by zero. */
export function divDecimal(a: Decimal, b: Decimal, places = DIVISION_PLACES): Decimal | null {
  if (b.units === ZERO) return null;
  const num = a.units * pow10(b.scale + places);
  const den = b.units * pow10(a.scale);
  let q = num / den;
  const r = num % den;
  const absR = r < ZERO ? -r : r;
  const absDen = den < ZERO ? -den : den;
  if (TWO * absR >= absDen) q += (num < ZERO) !== (den < ZERO) ? -ONE : ONE;
  return { units: q, scale: places };
}

function wholeAndRest(d: Decimal): { whole: bigint; rest: bigint; div: bigint } {
  const div = pow10(d.scale);
  return { whole: d.units / div, rest: d.units % div, div };
}

/** Largest whole number at or below the value (−1.5 → −2). */
export function floorDecimal(d: Decimal): Decimal {
  const { whole, rest } = wholeAndRest(d);
  return { units: rest !== ZERO && d.units < ZERO ? whole - ONE : whole, scale: 0 };
}

/** Smallest whole number at or above the value (1.2 → 2). */
export function ceilDecimal(d: Decimal): Decimal {
  const { whole, rest } = wholeAndRest(d);
  return { units: rest !== ZERO && d.units > ZERO ? whole + ONE : whole, scale: 0 };
}

/** Nearest whole number, halves away from zero (2.5 → 3, −2.5 → −3). */
export function roundDecimal(d: Decimal): Decimal {
  const { whole, rest, div } = wholeAndRest(d);
  const absRest = rest < ZERO ? -rest : rest;
  if (TWO * absRest < div) return { units: whole, scale: 0 };
  return { units: d.units < ZERO ? whole - ONE : whole + ONE, scale: 0 };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < ZERO ? -a : a;
  let y = b < ZERO ? -b : b;
  while (y !== ZERO) [x, y] = [y, x % y];
  return x;
}

/** num/den as exact decimal text, or null when it doesn't terminate (1/3) or den is 0. */
export function rationalToDecimalText(num: bigint, den: bigint): string | null {
  if (den === ZERO) return null;
  const g = gcd(num, den);
  let n = num / g;
  let d = den / g;
  if (d < ZERO) {
    n = -n;
    d = -d;
  }
  let twos = 0;
  let fives = 0;
  let rest = d;
  while (rest % TWO === ZERO) {
    rest /= TWO;
    twos++;
  }
  while (rest % FIVE === ZERO) {
    rest /= FIVE;
    fives++;
  }
  if (rest !== ONE) return null;
  const scale = Math.max(twos, fives);
  return formatDecimal({ units: (n * pow10(scale)) / d, scale });
}
