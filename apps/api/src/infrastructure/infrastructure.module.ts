import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';
import { RedisService } from './redis.service.js';
import { TransactionRunner } from './transaction-runner.js';

@Global()
@Module({
  providers: [PrismaService, RedisService, TransactionRunner],
  exports: [PrismaService, RedisService, TransactionRunner],
})
export class InfrastructureModule {}
