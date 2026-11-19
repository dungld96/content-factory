import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';

import {
  ApiErrorCode,
  assetIdParamsSchema,
  assetSchema,
  assetUsageSchema,
  lineageQuerySchema,
  lineageResponseSchema,
  listAssetsQuerySchema,
  listSchema,
  pageSchema,
  projectIdParamsSchema,
  STREAMABLE_MEDIA_TYPES,
  registerAssetRequestSchema,
  updateAssetRequestSchema,
  UPLOADABLE_AUDIO_TYPES,
  UPLOADABLE_IMAGE_TYPES,
  uploadAssetQuerySchema,
  type AssetDto,
  type AssetUsageDto,
  type LineageResponse,
  type Page,
  type RegisterAssetRequest,
  type UpdateAssetRequest,
  type UploadAssetQuery,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import { parseRange, type RangeRequest } from '../common/http/range.js';
import { AssetsService } from './assets.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type AssetParams = z.infer<typeof assetIdParamsSchema>;
const tags = ['assets'];

@Controller()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post('projects/:projectId/assets')
  @Endpoint({
    summary: 'Register asset metadata (editor); the storage key must be under the project',
    tags,
    params: projectIdParamsSchema,
    body: registerAssetRequestSchema,
    responses: { 201: { description: 'Registered', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  register(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: RegisterAssetRequest,
  ): Promise<AssetDto> {
    return this.assets.register(actor, params.projectId, body);
  }

  @Post('projects/:projectId/assets/upload')
  @Endpoint({
    summary:
      'Upload an image or audio file (editor): the raw file is the request body (≤ 25 MB; PNG/JPEG/WebP, MP3/WAV/M4A)',
    tags,
    params: projectIdParamsSchema,
    query: uploadAssetQuerySchema,
    binaryBody: [...UPLOADABLE_IMAGE_TYPES, ...UPLOADABLE_AUDIO_TYPES],
    responses: { 201: { description: 'Stored and registered', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409, 413, 415, 422, 503],
  })
  upload(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: UploadAssetQuery,
    @Req() request: Request,
  ): Promise<AssetDto> {
    return this.assets.upload(actor, params.projectId, query, request);
  }

  @Get('assets/:assetId/content')
  @Endpoint({
    summary: "Stream an asset's bytes (viewer); single byte ranges for audio/video seeking",
    tags,
    params: assetIdParamsSchema,
    responses: {
      200: { description: 'The file (206 for a byte range)', binary: STREAMABLE_MEDIA_TYPES },
    },
    errors: [400, 401, 404, 416, 503],
  })
  async content(
    @CurrentActor() actor: Actor,
    @ValidParams() params: AssetParams,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const header = request.headers.range;
    // The range is resolved once the asset (and its size) is known.
    const requested: { parsed: RangeRequest } = { parsed: { kind: 'none' } };
    const { asset, body, range } = await this.assets.content(actor, params.assetId, (a) => {
      requested.parsed = parseRange(header, Number(a.sizeBytes));
      const p = requested.parsed;
      return p.kind === 'range' ? { start: p.start, end: p.end } : undefined;
    });
    const size = Number(asset.sizeBytes);
    const etag = `"${asset.checksumSha256}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Accept-Ranges', 'bytes');
    if (requested.parsed.kind === 'unsatisfiable') {
      body.stream.destroy();
      response.setHeader('Content-Range', `bytes */${String(size)}`);
      throw new ApiError({
        status: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        code: ApiErrorCode.RangeNotSatisfiable,
        message: 'The requested byte range is outside the file.',
      });
    }
    if (!range && request.headers['if-none-match'] === etag) {
      body.stream.destroy();
      response.status(304);
      return undefined;
    }
    response.setHeader('Content-Type', asset.mimeType);
    response.setHeader('Content-Disposition', 'inline');
    if (range) {
      const end = range.end ?? size - 1;
      response.status(206);
      response.setHeader(
        'Content-Range',
        `bytes ${String(range.start)}-${String(end)}/${String(size)}`,
      );
      response.setHeader('Content-Length', String(end - range.start + 1));
    } else {
      response.setHeader('Content-Length', String(body.sizeBytes));
    }
    return new StreamableFile(body.stream);
  }

  @Get('projects/:projectId/assets')
  @Endpoint({
    summary: 'List assets',
    tags,
    params: projectIdParamsSchema,
    query: listAssetsQuerySchema,
    responses: { 200: { description: 'Page of assets', schema: pageSchema(assetSchema) } },
    errors: [400, 401, 404],
  })
  list(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: z.output<typeof listAssetsQuerySchema>,
  ): Promise<Page<AssetDto>> {
    return this.assets.list(actor, params.projectId, query);
  }

  @Get('assets/:assetId')
  @Endpoint({
    summary: 'Get an asset',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'The asset', schema: assetSchema } },
    errors: [400, 401, 404],
  })
  get(@CurrentActor() actor: Actor, @ValidParams() params: AssetParams): Promise<AssetDto> {
    return this.assets.get(actor, params.assetId);
  }

  @Get('assets/:assetId/lineage')
  @Endpoint({
    summary: 'Ancestors or descendants of an asset',
    tags,
    params: assetIdParamsSchema,
    query: lineageQuerySchema,
    responses: { 200: { description: 'Lineage', schema: lineageResponseSchema } },
    errors: [400, 401, 404],
  })
  lineage(
    @CurrentActor() actor: Actor,
    @ValidParams() params: AssetParams,
    @ValidQuery() query: z.output<typeof lineageQuerySchema>,
  ): Promise<LineageResponse> {
    return this.assets.lineage(actor, params.assetId, query);
  }

  @Get('assets/:assetId/usages')
  @Endpoint({
    summary: 'Character and environment versions that reference the asset',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'Usages', schema: listSchema(assetUsageSchema) } },
    errors: [400, 401, 404],
  })
  usages(
    @CurrentActor() actor: Actor,
    @ValidParams() params: AssetParams,
  ): Promise<{ data: AssetUsageDto[] }> {
    return this.assets.usages(actor, params.assetId);
  }

  @Patch('assets/:assetId')
  @Endpoint({
    summary: "Update an asset's label or metadata (editor)",
    tags,
    params: assetIdParamsSchema,
    body: updateAssetRequestSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Updated', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409, 412, 428],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: AssetParams,
    @ValidBody() body: UpdateAssetRequest,
    @IfMatch() expected: Date | undefined,
  ): Promise<AssetDto> {
    return this.assets.update(actor, params.assetId, body, expected);
  }

  @Post('assets/:assetId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive an asset (editor); refused while an approved version uses it',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'Archived', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archive(@CurrentActor() actor: Actor, @ValidParams() params: AssetParams): Promise<AssetDto> {
    return this.assets.archive(actor, params.assetId);
  }
}
