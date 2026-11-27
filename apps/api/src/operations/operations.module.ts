import { Module } from '@nestjs/common';

import { GenerationModule } from '../generation/generation.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { CostsService } from './costs.service.js';
import { OperationsController } from './operations.controller.js';
import { OpsService } from './ops.service.js';

/** Operations summary, held reservations and the cost dashboard (M7c). */
@Module({
  imports: [ProjectsModule, GenerationModule],
  controllers: [OperationsController],
  providers: [OpsService, CostsService],
})
export class OperationsModule {}
