import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ArtifactsService } from './artifacts.service.js';
import { GenerationController } from './generation.controller.js';
import { GenerationQueue } from './generation.queue.js';
import { GenerationService } from './generation.service.js';

/** Script and storyboard pipeline (M3 design package §10). The worker runs the jobs. */
@Module({
  imports: [ProjectsModule, AiModule],
  controllers: [GenerationController],
  providers: [GenerationService, ArtifactsService, GenerationQueue],
})
export class GenerationModule {}
