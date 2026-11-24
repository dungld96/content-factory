import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { BudgetsController } from './budgets.controller.js';
import { BudgetsService } from './budgets.service.js';
import { SpendingSettingsController } from './spending-settings.controller.js';
import { SpendingSettingsService } from './spending-settings.service.js';

/** Budgets and cost reservations (M7). Generation services reserve through {@link BudgetsService}. */
@Module({
  imports: [ProjectsModule],
  controllers: [BudgetsController, SpendingSettingsController],
  providers: [BudgetsService, SpendingSettingsService],
  exports: [BudgetsService, SpendingSettingsService],
})
export class BudgetsModule {}
