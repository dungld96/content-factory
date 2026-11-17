// User administration CLI (decision D6). Usage (from the repository root):
//   pnpm user:create --email a@example.com --name "Display Name"
//   pnpm user:set-password --email a@example.com
//   pnpm user:disable --email a@example.com
// The password is read from stdin: typed without echo on a terminal, or piped
// (`printf '%s' "$PW" | pnpm user:create ...`). It is never accepted as an argument, because
// arguments are visible in process listings and shell history.
import 'reflect-metadata';

import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import { createPrismaClient } from '@acf/database';

import { PasswordHasher } from '../auth/password-hasher.js';
import { UserAdminError, UserAdminService } from '../users/user-admin.service.js';

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(prompt);
  muted = true;
  try {
    return await rl.question('');
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { email: { type: 'string' }, name: { type: 'string' } },
    strict: true,
  });
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (see .env.example).');
    return 2;
  }
  if (!values.email) {
    console.error('--email is required');
    return 2;
  }
  const prisma = createPrismaClient({ databaseUrl, maxConnections: 1 });
  const users = new UserAdminService(prisma, new PasswordHasher());
  try {
    switch (command) {
      case 'create': {
        if (!values.name) {
          console.error('--name is required');
          return 2;
        }
        const password = await readPassword('Password (min 12 characters): ');
        const user = await users.create({
          email: values.email,
          displayName: values.name,
          password,
        });
        console.info(`✔ created user ${user.email} (${user.id})`);
        return 0;
      }
      case 'set-password': {
        const password = await readPassword('New password (min 12 characters): ');
        const revoked = await users.setPassword(values.email, password);
        console.info(`✔ password changed; ${revoked} session(s) revoked`);
        return 0;
      }
      case 'disable': {
        const revoked = await users.disable(values.email);
        console.info(`✔ user disabled; ${revoked} session(s) revoked`);
        return 0;
      }
      default:
        console.error(
          'usage: user-cli <create|set-password|disable> --email <email> [--name <name>]',
        );
        return 2;
    }
  } catch (error) {
    if (error instanceof UserAdminError) {
      console.error(`✖ ${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('user-cli failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  },
);
