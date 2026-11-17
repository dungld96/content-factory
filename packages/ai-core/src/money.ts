/**
 * Exact, non-negative USD amounts (ADR-0012).
 *
 * Stored as a `bigint` count of 10⁻¹⁸ USD, matching PostgreSQL `NUMERIC(38,18)`. Provider prices
 * are USD per token with up to 22 decimals, and single LLM calls can cost less than one
 * micro-dollar, so integer micros would record real spend as zero.
 */
export const USD_SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(USD_SCALE);
/** `NUMERIC(38,18)` holds at most 38 significant digits. */
const MAX_UNITS = 10n ** 38n - 1n;

const DECIMAL = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Round `numerator / 10^shift` to the nearest integer, ties to even. */
function divideHalfEven(numerator: bigint, shift: number): bigint {
  if (shift <= 0) return numerator * 10n ** BigInt(-shift);
  const divisor = 10n ** BigInt(shift);
  const quotient = numerator / divisor;
  const twiceRemainder = (numerator % divisor) * 2n;
  if (twiceRemainder > divisor || (twiceRemainder === divisor && quotient % 2n === 1n)) {
    return quotient + 1n;
  }
  return quotient;
}

export class UsdAmount {
  static readonly ZERO = new UsdAmount(0n);

  private constructor(
    /** Count of 10⁻¹⁸ USD. */
    readonly units: bigint,
  ) {
    if (units < 0n) throw new MoneyError('USD amounts cannot be negative');
    if (units > MAX_UNITS) throw new MoneyError('USD amount exceeds NUMERIC(38,18)');
  }

  static fromUnits(units: bigint): UsdAmount {
    return new UsdAmount(units);
  }

  /**
   * Parses a non-negative decimal string (`"0.0012"`, `"4.16e-8"`) or a finite JSON number.
   * Digits beyond 18 decimals are rounded half-to-even; use {@link UsdAmount.isExact} to detect
   * that. Numbers are read from their shortest round-trip form, so `0.0012` parses as `0.0012`.
   */
  static parse(value: string | number): UsdAmount {
    const { digits, shift } = decompose(value);
    return new UsdAmount(divideHalfEven(digits, shift));
  }

  /** True when `value` is representable at 18 decimals without rounding. */
  static isExact(value: string | number): boolean {
    const { digits, shift } = decompose(value);
    return shift <= 0 || digits % 10n ** BigInt(shift) === 0n;
  }

  add(other: UsdAmount): UsdAmount {
    return new UsdAmount(this.units + other.units);
  }

  /** Exact product with a non-negative integer quantity (tokens, requests). */
  times(quantity: number | bigint): UsdAmount {
    const q = typeof quantity === 'bigint' ? quantity : BigInt(checkQuantity(quantity));
    if (q < 0n) throw new MoneyError('quantity cannot be negative');
    return new UsdAmount(this.units * q);
  }

  static sum(amounts: Iterable<UsdAmount>): UsdAmount {
    let total = 0n;
    for (const amount of amounts) total += amount.units;
    return new UsdAmount(total);
  }

  equals(other: UsdAmount): boolean {
    return this.units === other.units;
  }

  compare(other: UsdAmount): -1 | 0 | 1 {
    return this.units < other.units ? -1 : this.units > other.units ? 1 : 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  /** Canonical decimal string without exponent or trailing zeros, e.g. `"0.0012"`, `"3"`. */
  toString(): string {
    const integer = this.units / SCALE_FACTOR;
    const fraction = (this.units % SCALE_FACTOR)
      .toString()
      .padStart(USD_SCALE, '0')
      .replace(/0+$/, '');
    return fraction.length > 0 ? `${integer.toString()}.${fraction}` : integer.toString();
  }

  /** Amounts serialize as decimal strings, never JSON numbers. */
  toJSON(): string {
    return this.toString();
  }
}

/**
 * Splits a decimal into an integer digit string and the power of ten that turns it into 10⁻¹⁸
 * units: `units = digits / 10^shift` (a negative shift multiplies).
 */
function decompose(value: string | number): { digits: bigint; shift: number } {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError('USD amount must be finite');
    text = String(value);
  } else {
    text = value.trim();
  }
  const match = DECIMAL.exec(text);
  if (!match) throw new MoneyError(`not a non-negative decimal: ${JSON.stringify(value)}`);
  const integer = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new MoneyError('USD amount exponent out of range');
  }
  // value = digits × 10^(exponent − fraction.length); units = value × 10^18.
  return { digits: BigInt(integer + fraction), shift: fraction.length - exponent - USD_SCALE };
}

function checkQuantity(quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError('quantity must be a non-negative safe integer');
  }
  return quantity;
}
