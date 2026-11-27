import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

function describe(e: unknown) {
  const err = e as Record<string, unknown> & { meta?: Record<string, unknown> };
  return JSON.stringify({ name: err.constructor?.name, code: err.code, meta: err.meta, msg: String(err.message).split('\n').slice(-2).join(' ') });
}
async function attempt(label: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(label, 'NO ERROR'); } catch (e) { console.log(label, describe(e)); }
}
await attempt('model update on approved version', () =>
  prisma.characterVersion.update({ where: { id: '31000000-0000-7000-8000-000000000001' }, data: { description: 'x' } }));
await attempt('deferred AC004 at interactive-tx commit', () =>
  prisma.$transaction(async (tx) => {
    await tx.characterVersion.update({ where: { id: '31000000-0000-7000-8000-000000000004' },
      data: { status: 'approved', approvedAt: new Date(), approvedById: '00000000-0000-7000-8000-000000000001' } });
  }));
await attempt('unique violation (slug)', () =>
  prisma.character.create({ data: { projectId: '10000000-0000-7000-8000-000000000001', name: 'dup', slug: 'khanh', createdById: '00000000-0000-7000-8000-000000000001' } }));
await attempt('FK composite violation', () =>
  prisma.characterVersionAsset.create({ data: { projectId: '10000000-0000-7000-8000-000000000001', characterVersionId: '31000000-0000-7000-8000-000000000004', assetId: '20000000-0000-7000-8000-000000000009' } }));
// service approval algorithm through Prisma (row locks via $queryRaw inside an interactive tx)
await attempt('service approval of v4 when master is v5 (stale draft)', () =>
  prisma.$transaction(async (tx) => {
    const [c] = await tx.$queryRaw<{ master_version_id: string | null }[]>`SELECT master_version_id FROM characters WHERE id = ${'30000000-0000-7000-8000-000000000001'}::uuid FOR NO KEY UPDATE`;
    const [v] = await tx.$queryRaw<{ version: number; status: string }[]>`SELECT version, status::text FROM character_versions WHERE id = ${'31000000-0000-7000-8000-000000000004'}::uuid FOR UPDATE`;
    const [m] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM character_versions WHERE id = ${c!.master_version_id}::uuid`;
    if (v!.version <= m!.version) throw Object.assign(new Error('STALE_DRAFT'), { code: 'STALE_DRAFT' });
  }));
const v6 = await prisma.characterVersion.create({ data: { projectId: '10000000-0000-7000-8000-000000000001', characterId: '30000000-0000-7000-8000-000000000001', version: 6, description: 'v6', createdById: '00000000-0000-7000-8000-000000000001' } });
console.log('created v6 with uuid(7) id', v6.id, 'version digit', v6.id[14]);
await attempt('service approval of v6 (happy path)', () =>
  prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM characters WHERE id = ${'30000000-0000-7000-8000-000000000001'}::uuid FOR NO KEY UPDATE`;
    await tx.characterVersion.update({ where: { id: v6.id, status: 'draft' }, data: { status: 'approved', approvedAt: new Date(), approvedById: '00000000-0000-7000-8000-000000000002' } });
    await tx.character.update({ where: { id: '30000000-0000-7000-8000-000000000001' }, data: { masterVersionId: v6.id } });
  }).then(() => { throw new Error('ok (committed)'); }));
await prisma.$disconnect();
