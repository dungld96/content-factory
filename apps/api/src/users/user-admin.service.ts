import { z } from 'zod';

import { databaseErrorInfo, PostgresSqlState, type PrismaClient } from '@acf/database';

import { normalizeEmail } from '../auth/auth.service.js';
import type { PasswordHasher } from '../auth/password-hasher.js';

/** New passwords: at least 12 characters (NIST SP 800-63B favours length over composition). */
export const newPasswordSchema = z.string().min(12, 'must be at least 12 characters').max(1024);

export const newUserSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .max(320)
    .transform(normalizeEmail)
    .pipe(z.email({ message: 'must be a valid email address' })),
  displayName: z.string().trim().min(1).max(120),
  password: newPasswordSchema,
});
export type NewUser = z.input<typeof newUserSchema>;

export class UserAdminError extends Error {
  override readonly name = 'UserAdminError';
  constructor(
    readonly code: 'EMAIL_TAKEN' | 'USER_NOT_FOUND' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
      .join('; ');
    throw new UserAdminError('INVALID_INPUT', detail);
  }
  return result.data;
}

/**
 * Account provisioning for the CLI (decision D6: users via CLI and seed only; no sign-up).
 * Password changes and disabling revoke every session of the user in the same transaction
 * (ADR-0009 requirement 5).
 */
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hasher: PasswordHasher,
  ) {}

  async create(input: NewUser): Promise<{ id: string; email: string }> {
    const data = parse(newUserSchema, input);
    try {
      return await this.prisma.user.create({
        data: {
          email: data.email,
          displayName: data.displayName,
          passwordHash: await this.hasher.hash(data.password),
        },
        select: { id: true, email: true },
      });
    } catch (error) {
      if (databaseErrorInfo(error)?.sqlState === PostgresSqlState.UNIQUE_VIOLATION) {
        throw new UserAdminError('EMAIL_TAKEN', 'A user with this email already exists.');
      }
      throw error;
    }
  }

  /** Sets a new password and revokes all sessions. Returns the number of revoked sessions. */
  async setPassword(email: string, password: string): Promise<number> {
    const hash = await this.hasher.hash(parse(newPasswordSchema, password));
    return this.updateAndRevoke(email, { passwordHash: hash, passwordChangedAt: new Date() });
  }

  /** Disables the account and revokes all sessions. Returns the number of revoked sessions. */
  disable(email: string): Promise<number> {
    return this.updateAndRevoke(email, { status: 'disabled' });
  }

  private async updateAndRevoke(
    email: string,
    data: { passwordHash?: string; passwordChangedAt?: Date; status?: 'disabled' },
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { email: normalizeEmail(email) },
        select: { id: true },
      });
      if (!user) throw new UserAdminError('USER_NOT_FOUND', 'No user has this email.');
      await tx.user.update({ where: { id: user.id }, data });
      const { count } = await tx.session.deleteMany({ where: { userId: user.id } });
      return count;
    });
  }
}
