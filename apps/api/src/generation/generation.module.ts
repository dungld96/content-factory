import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { BudgetsModule } from '../budgets/budgets.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ArtifactsService } from './artifacts.service.js';
import { GenerationController } from './generation.controller.js';
import { GenerationQueue } from './generation.queue.js';
import { GenerationService } from './generation.service.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';
import { MediaController } from './media.controller.js';
import { RendersController } from './renders.controller.js';
import { RendersService } from './renders.service.js';
import { ResumeService } from './resume.service.js';
import { VideosService } from './videos.service.js';
import { VoiceoversService } from './voiceovers.service.js';
import { VoiceProfilesService } from './voice-profiles.service.js';

/** Script, storyboard (M3), scene image (M4) and clip/voice-over (M5) pipeline. The worker runs the jobs. */
@Module({
  imports: [ProjectsModule, AiModule, BudgetsModule],
  controllers: [GenerationController, ImagesController, MediaController, RendersController],
  providers: [
    GenerationService,
    ArtifactsService,
    GenerationQueue,
    ImagesService,
    VideosService,
    VoiceoversService,
    VoiceProfilesService,
    RendersService,
    ResumeService,
  ],
  exports: [GenerationQueue],
})
export class GenerationModule {}
