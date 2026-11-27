import { randomBytes } from 'node:crypto';

let lastMs = 0;
let sequence = 0;

/**
 * RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, version 7, variant 10, then random bits.
 * Matches Prisma's `@default(uuid(7))` for rows inserted with raw SQL (PostgreSQL 17 has no
 * `uuidv7()`). Within one millisecond, a 12-bit counter in `rand_a` keeps ids of this process
 * monotonic (RFC 9562 §6.2, method 1). Not a security token.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    sequence = randomBytes(2).readUInt16BE(0) & 0x7ff; // leave headroom before overflow
  } else {
    sequence++;
    if (sequence > 0xfff) {
      lastMs++; // counter exhausted: borrow the next millisecond
      sequence = 0;
    }
  }
  const bytes = randomBytes(16);
  const ms = BigInt(lastMs);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
