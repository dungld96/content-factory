import { Controller, Get, Put } from '@nestjs/common';

import {
  spendingSettingsSchema,
  updateSpendingSettingsRequestSchema,
  type SpendingSettingsDto,
  type UpdateSpendingSettingsRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody } from '../common/http/endpoint.js';
import { SpendingSettingsService } from './spending-settings.service.js';

const tags = ['budgets'];

/** Workspace spending settings (redesign R-D4). */
@Controller('settings/spending')
export class SpendingSettingsController {
  constructor(private readonly settings: SpendingSettingsService) {}

  @Get()
  @Endpoint({
    summary: 'The workspace cost-confirmation threshold',
    tags,
    responses: { 200: { description: 'Settings', schema: spendingSettingsSchema } },
    errors: [401],
  })
  get(): Promise<SpendingSettingsDto> {
    return this.settings.get();
  }

  @Put()
  @Endpoint({
    summary: 'Change the workspace cost-confirmation threshold (operators)',
    tags,
    headers: ['x-csrf-token'],
    body: updateSpendingSettingsRequestSchema,
    responses: { 200: { description: 'Settings', schema: spendingSettingsSchema } },
    errors: [400, 401, 403],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidBody() body: UpdateSpendingSettingsRequest,
  ): Promise<SpendingSettingsDto> {
    return this.settings.update(actor, body);
  }
}
