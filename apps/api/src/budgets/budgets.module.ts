import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { BudgetsController } from './budgets.controller.js';
import { BudgetsService } from './budgets.service.js';

/** Budgets and cost reservations (M7). Generation services reserve through {@link BudgetsService}. */
@Module({
  imports: [ProjectsModule],
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService],
})
export class BudgetsModule {}
