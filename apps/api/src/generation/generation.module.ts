import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ArtifactsService } from './artifacts.service.js';
import { GenerationController } from './generation.controller.js';
import { GenerationQueue } from './generation.queue.js';
import { GenerationService } from './generation.service.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';

/** Script, storyboard (M3) and scene image (M4) pipeline. The worker runs the jobs. */
@Module({
  imports: [ProjectsModule, AiModule],
  controllers: [GenerationController, ImagesController],
  providers: [GenerationService, ArtifactsService, GenerationQueue, ImagesService],
})
export class GenerationModule {}
