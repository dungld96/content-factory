import { UsdAmount } from '@acf/ai-core';
import type { Prisma } from '@acf/database';

/**
 * Prisma `Decimal` → exact {@link UsdAmount}. `Decimal#toString()` switches to exponent notation
 * for small values (`7.2e-8`); `toFixed()` never does, and the column scale (18) is exact.
 */
export function usdFromDecimal(value: Prisma.Decimal): UsdAmount {
  return UsdAmount.parse(value.toFixed());
}

/** Decimal column → canonical decimal string for the API (`"0.000000072"`), or null. */
export function usdString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : usdFromDecimal(value).toString();
}
