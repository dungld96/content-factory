import { Controller, Get, HttpCode, Inject, Patch, Post, Put, type Type } from '@nestjs/common';
import { z } from 'zod';

import {
  createVersionedEntityRequestSchema,
  createVersionRequestSchema,
  listVersionedEntitiesQuerySchema,
  listVersionsQuerySchema,
  pageSchema,
  projectIdParamsSchema,
  replaceVersionAssetsRequestSchema,
  updateVersionedEntityRequestSchema,
  updateVersionRequestSchema,
  versionedEntitySchema,
  versionIdParamsSchema,
  versionSchema,
  type CreateVersionedEntityRequest,
  type CreateVersionRequest,
  type Page,
  type ReplaceVersionAssetsRequest,
  type UpdateVersionedEntityRequest,
  type UpdateVersionRequest,
  type VersionDto,
  type VersionedEntityDto,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import type { VersionedEntityService } from './versioned-entity.service.js';

export interface VersionedRoutes {
  /** Injection token of the kind's {@link VersionedEntityService}. */
  readonly token: symbol;
  /** `characters` / `environments`. */
  readonly plural: string;
  /** `characterId` / `environmentId`. */
  readonly idParam: string;
  /** `character-versions` / `environment-versions`. */
  readonly versionsPath: string;
  /** `Character` / `Environment` (class name prefix and OpenAPI tag). */
  readonly name: string;
}

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type VersionParams = z.infer<typeof versionIdParamsSchema>;

/**
 * Builds the controller for one versioned kind (design package §8.2: characters and
 * environments expose the same shapes). Controllers stay thin; rules live in the service.
 */
export function createVersionedController(routes: VersionedRoutes): Type {
  const { plural, idParam, versionsPath, name } = routes;
  const parentParams = z.strictObject({ [idParam]: z.uuid() });
  const tags = [plural];
  const label = name.toLowerCase();
  const idOf = (params: Record<string, string>) => params[idParam] ?? '';

  @Controller()
  class VersionedController {
    constructor(@Inject(routes.token) private readonly service: VersionedEntityService) {}

    @Post(`projects/:projectId/${plural}`)
    @Endpoint({
      summary: `Create a ${label} (editor)`,
      tags,
      params: projectIdParamsSchema,
      body: createVersionedEntityRequestSchema,
      responses: { 201: { description: 'Created', schema: versionedEntitySchema } },
      errors: [400, 401, 403, 404, 409],
    })
    create(
      @CurrentActor() actor: Actor,
      @ValidParams() params: ProjectParams,
      @ValidBody() body: CreateVersionedEntityRequest,
    ): Promise<VersionedEntityDto> {
      return this.service.create(actor, params.projectId, body);
    }

    @Get(`projects/:projectId/${plural}`)
    @Endpoint({
      summary: `List ${plural} with their master version`,
      tags,
      params: projectIdParamsSchema,
      query: listVersionedEntitiesQuerySchema,
      responses: { 200: { description: 'Page', schema: pageSchema(versionedEntitySchema) } },
      errors: [400, 401, 404],
    })
    list(
      @CurrentActor() actor: Actor,
      @ValidParams() params: ProjectParams,
      @ValidQuery() query: z.output<typeof listVersionedEntitiesQuerySchema>,
    ): Promise<Page<VersionedEntityDto>> {
      return this.service.list(actor, params.projectId, query);
    }

    @Get(`${plural}/:${idParam}`)
    @Endpoint({
      summary: `Get a ${label}`,
      tags,
      params: parentParams,
      responses: { 200: { description: `The ${label}`, schema: versionedEntitySchema } },
      errors: [400, 401, 404],
    })
    get(
      @CurrentActor() actor: Actor,
      @ValidParams() params: Record<string, string>,
    ): Promise<VersionedEntityDto> {
      return this.service.get(actor, idOf(params));
    }

    @Patch(`${plural}/:${idParam}`)
    @Endpoint({
      summary: `Update a ${label}'s name, slug or description (editor); never the master`,
      tags,
      params: parentParams,
      body: updateVersionedEntityRequestSchema,
      headers: ['If-Match'],
      responses: { 200: { description: 'Updated', schema: versionedEntitySchema } },
      errors: [400, 401, 403, 404, 409, 412, 428],
    })
    update(
      @CurrentActor() actor: Actor,
      @ValidParams() params: Record<string, string>,
      @ValidBody() body: UpdateVersionedEntityRequest,
      @IfMatch() expected: Date | undefined,
    ): Promise<VersionedEntityDto> {
      return this.service.update(actor, idOf(params), body, expected);
    }

    @Post(`${plural}/:${idParam}/archive`)
    @HttpCode(200)
    @Endpoint({
      summary: `Archive a ${label} (editor)`,
      tags,
      params: parentParams,
      responses: { 200: { description: 'Archived', schema: versionedEntitySchema } },
      errors: [400, 401, 403, 404, 409],
    })
    archive(
      @CurrentActor() actor: Actor,
      @ValidParams() params: Record<string, string>,
    ): Promise<VersionedEntityDto> {
      return this.service.archive(actor, idOf(params));
    }

    @Post(`${plural}/:${idParam}/restore`)
    @HttpCode(200)
    @Endpoint({
      summary: `Restore an archived ${label} (editor)`,
      tags,
      params: parentParams,
      responses: { 200: { description: 'Restored', schema: versionedEntitySchema } },
      errors: [400, 401, 403, 404, 409],
    })
    restore(
      @CurrentActor() actor: Actor,
      @ValidParams() params: Record<string, string>,
    ): Promise<VersionedEntityDto> {
      return this.service.restore(actor, idOf(params));
    }

    @Post(`${plural}/:${idParam}/versions`)
    @Endpoint({
      summary: `Create a draft version (editor); basedOnVersionId copies an older version`,
      tags,
      params: parentParams,
      body: createVersionRequestSchema,
      responses: { 201: { description: 'Draft created', schema: versionSchema } },
      errors: [400, 401, 403, 404, 409, 422],
    })
    createVersion(
      @CurrentActor() actor: Actor,
      @ValidParams() params: Record<string, string>,
      @ValidBody() body: CreateVersionRequest,
    ): Promise<VersionDto> {
      return this.service.createVersion(actor, idOf(params), body);
    }

    @Get(`${plural}/:${idParam}/versions`)
    @Endpoint({
      summary: 'List versions, newest first',
      tags,
      params: parentParams,
      query: listVersionsQuerySchema,
      responses: { 200: { description: 'Page', schema: pageSchema(versionSchema) } },
      errors: [400, 401, 404],
    })
    listVersions(
      @CurrentActor() actor: Actor,
      @ValidParams() params: Record<string, string>,
      @ValidQuery() query: z.output<typeof listVersionsQuerySchema>,
    ): Promise<Page<VersionDto>> {
      return this.service.listVersions(actor, idOf(params), query);
    }

    @Get(`${versionsPath}/:versionId`)
    @Endpoint({
      summary: 'Get a version with its asset links',
      tags,
      params: versionIdParamsSchema,
      responses: { 200: { description: 'The version', schema: versionSchema } },
      errors: [400, 401, 404],
    })
    getVersion(
      @CurrentActor() actor: Actor,
      @ValidParams() params: VersionParams,
    ): Promise<VersionDto> {
      return this.service.getVersion(actor, params.versionId);
    }

    @Patch(`${versionsPath}/:versionId`)
    @Endpoint({
      summary: 'Edit a draft version (editor); approved versions are immutable',
      tags,
      params: versionIdParamsSchema,
      body: updateVersionRequestSchema,
      headers: ['If-Match'],
      responses: { 200: { description: 'Updated', schema: versionSchema } },
      errors: [400, 401, 403, 404, 409, 412, 422, 428],
    })
    updateVersion(
      @CurrentActor() actor: Actor,
      @ValidParams() params: VersionParams,
      @ValidBody() body: UpdateVersionRequest,
      @IfMatch() expected: Date | undefined,
    ): Promise<VersionDto> {
      return this.service.updateVersion(actor, params.versionId, body, expected);
    }

    @Put(`${versionsPath}/:versionId/assets`)
    @Endpoint({
      summary: "Replace a draft version's asset links (editor)",
      tags,
      params: versionIdParamsSchema,
      body: replaceVersionAssetsRequestSchema,
      headers: ['If-Match'],
      responses: { 200: { description: 'Updated', schema: versionSchema } },
      errors: [400, 401, 403, 404, 409, 412, 422, 428],
    })
    replaceAssets(
      @CurrentActor() actor: Actor,
      @ValidParams() params: VersionParams,
      @ValidBody() body: ReplaceVersionAssetsRequest,
      @IfMatch() expected: Date | undefined,
    ): Promise<VersionDto> {
      return this.service.replaceAssets(actor, params.versionId, body.assets, expected);
    }

    @Post(`${versionsPath}/:versionId/approve`)
    @HttpCode(200)
    @Endpoint({
      summary: 'Approve a draft; it becomes the master (editor)',
      tags,
      params: versionIdParamsSchema,
      headers: ['If-Match'],
      responses: { 200: { description: 'Approved', schema: versionSchema } },
      errors: [400, 401, 403, 404, 409, 412, 428],
    })
    approve(
      @CurrentActor() actor: Actor,
      @ValidParams() params: VersionParams,
      @IfMatch() expected: Date | undefined,
    ): Promise<VersionDto> {
      return this.service.approve(actor, params.versionId, expected);
    }
  }

  Object.defineProperty(VersionedController, 'name', { value: `${name}sController` });
  return VersionedController;
}
