import { Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import type { z } from 'zod';

import {
  assetIdParamsSchema,
  assetSchema,
  imageEstimateSchema,
  imageGenerateResponseSchema,
  imageGenerationRequestSchema,
  sceneIdParamsSchema,
  setKeyframeRequestSchema,
  storyboardImagesSchema,
  storyboardVersionIdParamsSchema,
  type AssetDto,
  type ImageEstimateDto,
  type ImageGenerateResponseDto,
  type ImageGenerationRequest,
  type SetKeyframeRequest,
  type StoryboardImagesDto,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams } from '../common/http/endpoint.js';
import { ImagesService } from './images.service.js';

type StoryboardParams = z.infer<typeof storyboardVersionIdParamsSchema>;
type SceneParams = z.infer<typeof sceneIdParamsSchema>;
type AssetParams = z.infer<typeof assetIdParamsSchema>;
const tags = ['images'];

/** Scene images (M4 design package §7). The worker runs the jobs. */
@Controller()
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post('storyboards/:storyboardVersionId/images/estimate')
  @HttpCode(200)
  @Endpoint({
    summary: 'Plan and price image generation for scenes of the approved storyboard (no cost)',
    tags,
    params: storyboardVersionIdParamsSchema,
    body: imageGenerationRequestSchema,
    responses: { 200: { description: 'Per-scene plan and estimate', schema: imageEstimateSchema } },
    errors: [400, 401, 404, 409, 422],
  })
  estimate(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
    @ValidBody() body: ImageGenerationRequest,
  ): Promise<ImageEstimateDto> {
    return this.images.estimate(actor, params.storyboardVersionId, body);
  }

  @Post('storyboards/:storyboardVersionId/images/generate')
  @HttpCode(202)
  @Endpoint({
    summary: 'Queue one image job per scene (editor); reuses identical earlier results',
    tags,
    params: storyboardVersionIdParamsSchema,
    body: imageGenerationRequestSchema,
    responses: { 202: { description: 'Queued', schema: imageGenerateResponseSchema } },
    errors: [400, 401, 403, 404, 409, 422, 503],
  })
  generate(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
    @ValidBody() body: ImageGenerationRequest,
  ): Promise<ImageGenerateResponseDto> {
    return this.images.generate(actor, params.storyboardVersionId, body);
  }

  @Get('storyboards/:storyboardVersionId/images')
  @Endpoint({
    summary: 'Keyframes, candidates and jobs of every scene',
    tags,
    params: storyboardVersionIdParamsSchema,
    responses: { 200: { description: 'Scene images', schema: storyboardImagesSchema } },
    errors: [400, 401, 404],
  })
  view(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
  ): Promise<StoryboardImagesDto> {
    return this.images.view(actor, params.storyboardVersionId);
  }

  @Put('scenes/:sceneId/keyframe')
  @Endpoint({
    summary: "Select an approved image as the scene's keyframe (editor)",
    tags,
    params: sceneIdParamsSchema,
    body: setKeyframeRequestSchema,
    responses: { 200: { description: 'Scene images', schema: storyboardImagesSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  setKeyframe(
    @CurrentActor() actor: Actor,
    @ValidParams() params: SceneParams,
    @ValidBody() body: SetKeyframeRequest,
  ): Promise<StoryboardImagesDto> {
    return this.images.setKeyframe(actor, params.sceneId, body.assetId);
  }

  @Post('assets/:assetId/approve')
  @HttpCode(200)
  @Endpoint({
    summary: 'Approve an image or reference image (editor)',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'Approved', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  approve(@CurrentActor() actor: Actor, @ValidParams() params: AssetParams): Promise<AssetDto> {
    return this.images.review(actor, params.assetId, 'approved');
  }

  @Post('assets/:assetId/reject')
  @HttpCode(200)
  @Endpoint({
    summary: 'Reject an image or reference image (editor); a keyframe cannot be rejected',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'Rejected', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  reject(@CurrentActor() actor: Actor, @ValidParams() params: AssetParams): Promise<AssetDto> {
    return this.images.review(actor, params.assetId, 'rejected');
  }
}
