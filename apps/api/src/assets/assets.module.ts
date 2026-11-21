import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { AssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';
import { CollectionsController } from './collections.controller.js';
import { CollectionsService } from './collections.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [AssetsController, CollectionsController],
  providers: [AssetsService, CollectionsService],
})
export class AssetsModule {}
