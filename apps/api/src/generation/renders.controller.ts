import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  contentIdParamsSchema,
  costReportSchema,
  createRenderRequestSchema,
  createRenderResponseSchema,
  rejectRenderRequestSchema,
  renderIdParamsSchema,
  renderListSchema,
  renderManifestDocumentSchema,
  renderPlanSchema,
  renderSchema,
  reviewRenderRequestSchema,
  type CostReportDto,
  type CreateRenderRequest,
  type CreateRenderResponseDto,
  type RejectRenderRequest,
  type RenderDto,
  type RenderListDto,
  type RenderManifestDocumentDto,
  type RenderPlanDto,
  type ReviewRenderRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams } from '../common/http/endpoint.js';
import { RendersService } from './renders.service.js';

type ContentParams = z.infer<typeof contentIdParamsSchema>;
type RenderParams = z.infer<typeof renderIdParamsSchema>;
const tags = ['renders'];

/** Renders, gate 5 and export (M6 design package §11). The worker renders. */
@Controller()
export class RendersController {
  constructor(private readonly renders: RendersService) {}

  @Get('content/:contentId/render-plan')
  @Endpoint({
    summary: 'Preflight: scenes, chosen clips and voice-overs, blockers, upscaling, music options',
    tags,
    params: contentIdParamsSchema,
    responses: { 200: { description: 'Render plan', schema: renderPlanSchema } },
    errors: [400, 401, 404, 409],
  })
  plan(@CurrentActor() actor: Actor, @ValidParams() params: ContentParams): Promise<RenderPlanDto> {
    return this.renders.plan(actor, params.contentId);
  }

  @Post('content/:contentId/renders')
  @HttpCode(202)
  @Endpoint({
    summary: 'Queue a render (editor); an identical earlier render is returned instead',
    tags,
    params: contentIdParamsSchema,
    body: createRenderRequestSchema,
    responses: { 202: { description: 'Queued or reused', schema: createRenderResponseSchema } },
    errors: [400, 401, 403, 404, 409, 422, 503],
  })
  create(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
    @ValidBody() body: CreateRenderRequest,
  ): Promise<CreateRenderResponseDto> {
    return this.renders.create(actor, params.contentId, body);
  }

  @Get('content/:contentId/renders')
  @Endpoint({
    summary: 'Renders of a content item, newest first',
    tags,
    params: contentIdParamsSchema,
    responses: { 200: { description: 'Renders', schema: renderListSchema } },
    errors: [400, 401, 404],
  })
  list(@CurrentActor() actor: Actor, @ValidParams() params: ContentParams): Promise<RenderListDto> {
    return this.renders.list(actor, params.contentId);
  }

  @Get('renders/:renderId')
  @Endpoint({
    summary: 'A render: status, outputs, QC report, review and export',
    tags,
    params: renderIdParamsSchema,
    responses: { 200: { description: 'Render', schema: renderSchema } },
    errors: [400, 401, 404],
  })
  get(@CurrentActor() actor: Actor, @ValidParams() params: RenderParams): Promise<RenderDto> {
    return this.renders.get(actor, params.renderId);
  }

  @Post('renders/:renderId/approve')
  @HttpCode(200)
  @Endpoint({
    summary: "Approve a render (gate 5, editor): it becomes the content item's approved export",
    tags,
    params: renderIdParamsSchema,
    body: reviewRenderRequestSchema,
    responses: { 200: { description: 'Approved', schema: renderSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  approve(
    @CurrentActor() actor: Actor,
    @ValidParams() params: RenderParams,
    @ValidBody() body: ReviewRenderRequest,
  ): Promise<RenderDto> {
    return this.renders.approve(actor, params.renderId, body.note);
  }

  @Post('renders/:renderId/reject')
  @HttpCode(200)
  @Endpoint({
    summary: 'Reject a render with a note (editor)',
    tags,
    params: renderIdParamsSchema,
    body: rejectRenderRequestSchema,
    responses: { 200: { description: 'Rejected', schema: renderSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  reject(
    @CurrentActor() actor: Actor,
    @ValidParams() params: RenderParams,
    @ValidBody() body: RejectRenderRequest,
  ): Promise<RenderDto> {
    return this.renders.reject(actor, params.renderId, body.note);
  }

  @Post('renders/:renderId/export')
  @HttpCode(200)
  @Endpoint({
    summary: 'Export an approved render (editor): marks the content item exported',
    tags,
    params: renderIdParamsSchema,
    responses: { 200: { description: 'Exported', schema: renderSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  export(@CurrentActor() actor: Actor, @ValidParams() params: RenderParams): Promise<RenderDto> {
    return this.renders.export(actor, params.renderId);
  }

  @Get('renders/:renderId/manifest')
  @Endpoint({
    summary: 'Package manifest: inputs, models, settings, QC, output checksums, script',
    tags,
    params: renderIdParamsSchema,
    responses: { 200: { description: 'Manifest', schema: renderManifestDocumentSchema } },
    errors: [400, 401, 404],
  })
  manifest(
    @CurrentActor() actor: Actor,
    @ValidParams() params: RenderParams,
  ): Promise<RenderManifestDocumentDto> {
    return this.renders.manifest(actor, params.renderId);
  }

  @Get('renders/:renderId/cost-report')
  @Endpoint({
    summary: 'Cost report: every AI call of the content item, by stage; unknown never as zero',
    tags,
    params: renderIdParamsSchema,
    responses: { 200: { description: 'Cost report', schema: costReportSchema } },
    errors: [400, 401, 404],
  })
  costReport(
    @CurrentActor() actor: Actor,
    @ValidParams() params: RenderParams,
  ): Promise<CostReportDto> {
    return this.renders.costReport(actor, params.renderId);
  }
}
