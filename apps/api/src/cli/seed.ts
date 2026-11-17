// Development-only demo workspace (owner decision, M1 review): `pnpm db:seed`.
// Creates three users (owner, editor, viewer) with random passwords printed ONCE, and a demo
// project with a channel, a content brief, a reference asset, and a character and an
// environment that each have an approved master version. Idempotent: does nothing if the demo
// owner already exists. Refuses to run with NODE_ENV=production. Runs as the migrator role
// (decision U3: migrations, seed and test setup use acf_migrator).
import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import { createPrismaClient, type PrismaClient } from '@acf/database';

import { PasswordHasher } from '../auth/password-hasher.js';
import { UserAdminService } from '../users/user-admin.service.js';
import { seedAiRegistry } from './seed-ai.js';

export const DEMO_DOMAIN = 'demo.acf.test';
const PEOPLE = [
  { key: 'owner', name: 'Demo Owner', role: 'owner' },
  { key: 'editor', name: 'Demo Editor', role: 'editor' },
  { key: 'viewer', name: 'Demo Viewer', role: 'viewer' },
] as const;

const password = () => randomBytes(18).toString('base64url');
const checksum = (seed: string) => Buffer.from(seed.padEnd(32, '0').slice(0, 32)).toString('hex');

export async function seedDemoWorkspace(
  prisma: PrismaClient,
): Promise<
  { created: false } | { created: true; credentials: { email: string; password: string }[] }
> {
  const ownerEmail = `owner@${DEMO_DOMAIN}`;
  if (await prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } })) {
    return { created: false };
  }
  const users = new UserAdminService(prisma, new PasswordHasher());
  const credentials: { email: string; password: string }[] = [];
  const ids: Record<string, string> = {};
  for (const person of PEOPLE) {
    const email = `${person.key}@${DEMO_DOMAIN}`;
    const pw = password();
    ids[person.key] = (await users.create({ email, displayName: person.name, password: pw })).id;
    credentials.push({ email, password: pw });
  }
  const ownerId = ids['owner'] ?? '';

  await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        name: 'Demo Studio',
        slug: 'demo-studio',
        description: 'Seeded demo workspace (development only).',
        defaultLanguage: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
        createdById: ownerId,
      },
    });
    await tx.projectMember.createMany({
      data: PEOPLE.map((p) => ({
        projectId: project.id,
        userId: ids[p.key] ?? '',
        role: p.role,
        addedById: ownerId,
      })),
    });
    const channel = await tx.channel.create({
      data: {
        projectId: project.id,
        name: 'Demo TikTok',
        slug: 'demo-tiktok',
        platform: 'tiktok',
        handle: '@demo',
        createdById: ownerId,
      },
    });
    await tx.contentItem.create({
      data: {
        projectId: project.id,
        channelId: channel.id,
        title: '5 useful desk gadgets',
        format: 'short_video',
        targetDurationSeconds: 30,
        aspectRatio: 'ratio_9_16',
        language: 'vi',
        brief: {
          topic: 'Useful technology products for office workers',
          audience: 'Vietnamese office workers',
          objective: 'education_and_affiliate',
          tone: 'modern, friendly',
          callToAction: 'Follow for more useful tech',
        },
        createdById: ownerId,
      },
    });
    const asset = await tx.asset.create({
      data: {
        projectId: project.id,
        assetType: 'reference',
        sourceType: 'upload',
        storageKey: `projects/${project.id}/references/host-front.png`,
        mimeType: 'image/png',
        sizeBytes: 245_760n,
        checksumSha256: checksum('demo-host-front'),
        width: 1080,
        height: 1920,
        originalFilename: 'host-front.png',
        label: 'Host, front view',
        createdById: ownerId,
      },
    });

    const character = await tx.character.create({
      data: { projectId: project.id, name: 'Khánh', slug: 'khanh', createdById: ownerId },
    });
    const cv = await tx.characterVersion.create({
      data: {
        projectId: project.id,
        characterId: character.id,
        version: 1,
        description: 'Friendly host in her late twenties, short black hair, casual office wear.',
        identityRules: { hair: 'short black', outfit: 'casual office', mustKeep: ['smile'] },
        primaryAssetId: asset.id,
        createdById: ownerId,
      },
    });
    // Approval moves the master in the same transaction (deferred trigger AC004).
    await tx.characterVersion.update({
      where: { id: cv.id },
      data: { status: 'approved', approvedAt: new Date(), approvedById: ownerId },
    });
    await tx.character.update({ where: { id: character.id }, data: { masterVersionId: cv.id } });

    const environment = await tx.environment.create({
      data: {
        projectId: project.id,
        name: 'Open office',
        slug: 'open-office',
        createdById: ownerId,
      },
    });
    const ev = await tx.environmentVersion.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        version: 1,
        description: 'Bright open-plan office, plants, warm afternoon light.',
        visualRules: { lighting: 'warm', palette: ['white', 'green', 'oak'] },
        createdById: ownerId,
      },
    });
    await tx.environmentVersion.update({
      where: { id: ev.id },
      data: { status: 'approved', approvedAt: new Date(), approvedById: ownerId },
    });
    await tx.environment.update({
      where: { id: environment.id },
      data: { masterVersionId: ev.id },
    });
  });

  return { created: true, credentials };
}

async function main(): Promise<number> {
  if (process.env['NODE_ENV'] === 'production') {
    console.error('✖ db:seed creates demo accounts and is refused with NODE_ENV=production.');
    return 1;
  }
  const databaseUrl = process.env['DATABASE_MIGRATION_URL'];
  if (!databaseUrl) {
    console.error('✖ DATABASE_MIGRATION_URL is not set (see .env.example).');
    return 2;
  }
  const prisma = createPrismaClient({ databaseUrl, maxConnections: 1 });
  try {
    const result = await seedDemoWorkspace(prisma);
    if (!result.created) {
      console.info(`✔ demo workspace already exists (users @${DEMO_DOMAIN}); nothing to do.`);
    } else {
      console.info('✔ demo workspace "Demo Studio" created. Sign-in credentials (shown once):');
      for (const c of result.credentials) console.info(`    ${c.email}  ${c.password}`);
      console.info('  Change a password with: pnpm user:set-password --email <email>');
    }
    const ai = await seedAiRegistry(prisma, {
      openrouterConfigured: Boolean(process.env['OPENROUTER_API_KEY']),
    });
    console.info(`✔ AI registry: openrouter ${ai.openrouterStatus}; mock provider enabled.`);
    for (const m of ai.models)
      console.info(`    ${m.modelKey}: ${m.action} (disabled until reviewed)`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly (the module is also imported by tests).
if (process.argv[1]?.endsWith('seed.js')) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('db:seed failed:', error instanceof Error ? error.message : 'unknown error');
      process.exit(1);
    },
  );
}
