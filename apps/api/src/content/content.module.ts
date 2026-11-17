import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [ContentController],
  providers: [ContentService],
})
export class ContentModule {}
