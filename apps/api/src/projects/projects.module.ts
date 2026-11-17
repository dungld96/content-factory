import { Module } from '@nestjs/common';

import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { ProjectAccess } from './project-access.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  controllers: [ProjectsController, MembersController],
  providers: [ProjectAccess, ProjectsService, MembersService],
  exports: [ProjectAccess],
})
export class ProjectsModule {}
