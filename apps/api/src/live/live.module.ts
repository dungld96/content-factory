import { Module } from '@nestjs/common';

import { LiveController } from './live.controller.js';
import { LiveEventsService } from './live-events.service.js';

/** Live job tracking (redesign R-D5): event stream, polling fallback, active jobs. */
@Module({
  controllers: [LiveController],
  providers: [LiveEventsService],
  exports: [LiveEventsService],
})
export class LiveModule {}
