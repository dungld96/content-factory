import { Global, Module } from '@nestjs/common';

import { ObjectStoreService } from './object-store.service.js';
import { PrismaService } from './prisma.service.js';
import { RedisService } from './redis.service.js';
import { TransactionRunner } from './transaction-runner.js';

@Global()
@Module({
  providers: [PrismaService, RedisService, TransactionRunner, ObjectStoreService],
  exports: [PrismaService, RedisService, TransactionRunner, ObjectStoreService],
})
export class InfrastructureModule {}
