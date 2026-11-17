import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { z } from 'zod';

import {
  createProjectRequestSchema,
  listProjectsQuerySchema,
  pageSchema,
  projectIdParamsSchema,
  projectSchema,
  updateProjectRequestSchema,
  type CreateProjectRequest,
  type Page,
  type ProjectDto,
  type UpdateProjectRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import { ProjectsService } from './projects.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @Endpoint({
    summary: 'Create a project; the caller becomes its owner',
    tags: ['projects'],
    body: createProjectRequestSchema,
    responses: { 201: { description: 'Created', schema: projectSchema } },
    errors: [400, 401, 403, 409],
  })
  create(
    @CurrentActor() actor: Actor,
    @ValidBody() body: CreateProjectRequest,
  ): Promise<ProjectDto> {
    return this.projects.create(actor, body);
  }

  @Get()
  @Endpoint({
    summary: "List the caller's projects",
    tags: ['projects'],
    query: listProjectsQuerySchema,
    responses: { 200: { description: 'Page of projects', schema: pageSchema(projectSchema) } },
    errors: [400, 401],
  })
  list(
    @CurrentActor() actor: Actor,
    @ValidQuery() query: z.output<typeof listProjectsQuerySchema>,
  ): Promise<Page<ProjectDto>> {
    return this.projects.list(actor, query);
  }

  @Get(':projectId')
  @Endpoint({
    summary: 'Get a project',
    tags: ['projects'],
    params: projectIdParamsSchema,
    responses: { 200: { description: 'The project', schema: projectSchema } },
    errors: [400, 401, 404],
  })
  get(@CurrentActor() actor: Actor, @ValidParams() params: ProjectParams): Promise<ProjectDto> {
    return this.projects.get(actor, params.projectId);
  }

  @Patch(':projectId')
  @Endpoint({
    summary: 'Update project metadata (owner)',
    tags: ['projects'],
    params: projectIdParamsSchema,
    body: updateProjectRequestSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Updated', schema: projectSchema } },
    errors: [400, 401, 403, 404, 409, 412, 428],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: UpdateProjectRequest,
    @IfMatch() expected: Date | undefined,
  ): Promise<ProjectDto> {
    return this.projects.update(actor, params.projectId, body, expected);
  }

  @Post(':projectId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive a project (owner); it becomes read-only',
    tags: ['projects'],
    params: projectIdParamsSchema,
    responses: { 200: { description: 'Archived', schema: projectSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archive(@CurrentActor() actor: Actor, @ValidParams() params: ProjectParams): Promise<ProjectDto> {
    return this.projects.archive(actor, params.projectId);
  }
}
