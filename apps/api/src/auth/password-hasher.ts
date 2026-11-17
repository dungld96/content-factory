import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Argon2id password hashing (argon2 0.45.x, PHC strings). Parameters are the library defaults
 * (m=64 MiB, t=3, p=4), which meet current OWASP guidance; changing them makes `needsRehash`
 * upgrade hashes transparently at the next login.
 */
export interface PasswordHashOptions {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const DEFAULT_PASSWORD_HASH_OPTIONS: PasswordHashOptions = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
};

@Injectable()
export class PasswordHasher {
  private readonly options: PasswordHashOptions = DEFAULT_PASSWORD_HASH_OPTIONS;
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, ...this.options });
  }

  /** Constant-shape verification; malformed hashes count as a mismatch. */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Verifies against a fixed dummy hash, so a login for an unknown email costs the same time
   * as one for a known email (no user enumeration by timing).
   */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-equalization');
    await this.verify(await this.dummyHash, password);
    return false;
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, { ...this.options });
    } catch {
      return true;
    }
  }
}
