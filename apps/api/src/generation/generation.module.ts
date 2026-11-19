import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ArtifactsService } from './artifacts.service.js';
import { GenerationController } from './generation.controller.js';
import { GenerationQueue } from './generation.queue.js';
import { GenerationService } from './generation.service.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';
import { MediaController } from './media.controller.js';
import { VideosService } from './videos.service.js';
import { VoiceoversService } from './voiceovers.service.js';
import { VoiceProfilesService } from './voice-profiles.service.js';

/** Script, storyboard (M3), scene image (M4) and clip/voice-over (M5) pipeline. The worker runs the jobs. */
@Module({
  imports: [ProjectsModule, AiModule],
  controllers: [GenerationController, ImagesController, MediaController],
  providers: [
    GenerationService,
    ArtifactsService,
    GenerationQueue,
    ImagesService,
    VideosService,
    VoiceoversService,
    VoiceProfilesService,
  ],
})
export class GenerationModule {}
