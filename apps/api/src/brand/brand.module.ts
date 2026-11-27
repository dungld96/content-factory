import { Module } from '@nestjs/common';

import { PrismaService } from '../infrastructure/prisma.service.js';
import { TransactionRunner } from '../infrastructure/transaction-runner.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { createVersionedController } from './versioned-entity.controller.js';
import { VersionedEntityService } from './versioned-entity.service.js';
import { CHARACTER_KIND, ENVIRONMENT_KIND, type VersionedKind } from './versioned-kind.js';

export const CHARACTERS = Symbol('CHARACTERS');
export const ENVIRONMENTS = Symbol('ENVIRONMENTS');

const serviceFor = (token: symbol, kind: VersionedKind) => ({
  provide: token,
  inject: [PrismaService, TransactionRunner, ProjectAccess],
  useFactory: (prisma: PrismaService, runner: TransactionRunner, access: ProjectAccess) =>
    new VersionedEntityService(kind, prisma, runner, access),
});

/** Characters and environments with versions and approval (ADR-0010). */
@Module({
  imports: [ProjectsModule],
  controllers: [
    createVersionedController({
      token: CHARACTERS,
      plural: 'characters',
      idParam: 'characterId',
      versionsPath: 'character-versions',
      name: 'Character',
    }),
    createVersionedController({
      token: ENVIRONMENTS,
      plural: 'environments',
      idParam: 'environmentId',
      versionsPath: 'environment-versions',
      name: 'Environment',
    }),
  ],
  providers: [serviceFor(CHARACTERS, CHARACTER_KIND), serviceFor(ENVIRONMENTS, ENVIRONMENT_KIND)],
  exports: [CHARACTERS, ENVIRONMENTS],
})
export class BrandModule {}
