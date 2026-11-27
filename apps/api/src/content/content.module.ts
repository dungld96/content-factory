import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { ContentMastersController } from './content-masters.controller.js';
import { ContentMastersService } from './content-masters.service.js';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [ContentController, ContentMastersController],
  providers: [ContentService, ContentMastersService],
})
export class ContentModule {}
