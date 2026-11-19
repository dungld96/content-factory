import { Controller, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import type { z } from 'zod';

import {
  createVoiceProfileRequestSchema,
  generationJobSchema,
  jobIdParamsSchema,
  listVoiceProfilesQuerySchema,
  projectIdParamsSchema,
  sceneIdParamsSchema,
  selectSceneMediaRequestSchema,
  storyboardVersionIdParamsSchema,
  storyboardVideosSchema,
  storyboardVoiceoversSchema,
  updateVoiceProfileRequestSchema,
  videoEstimateSchema,
  videoGenerateResponseSchema,
  videoGenerationRequestSchema,
  voiceoverEstimateSchema,
  voiceoverGenerateResponseSchema,
  voiceoverGenerationRequestSchema,
  voiceProfileIdParamsSchema,
  voiceProfileListSchema,
  voiceProfileSchema,
  type CreateVoiceProfileRequest,
  type GenerationJobDto,
  type SelectSceneMediaRequest,
  type StoryboardVideosDto,
  type StoryboardVoiceoversDto,
  type UpdateVoiceProfileRequest,
  type VideoEstimateDto,
  type VideoGenerateResponseDto,
  type VideoGenerationRequest,
  type VoiceoverEstimateDto,
  type VoiceoverGenerateResponseDto,
  type VoiceoverGenerationRequest,
  type VoiceProfileDto,
  type VoiceProfileListDto,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { VideosService } from './videos.service.js';
import { VoiceoversService } from './voiceovers.service.js';
import { VoiceProfilesService } from './voice-profiles.service.js';

type StoryboardParams = z.infer<typeof storyboardVersionIdParamsSchema>;
type SceneParams = z.infer<typeof sceneIdParamsSchema>;
type JobParams = z.infer<typeof jobIdParamsSchema>;
type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type ProfileParams = z.infer<typeof voiceProfileIdParamsSchema>;
type ProfileQuery = z.output<typeof listVoiceProfilesQuerySchema>;

/** Scene clips, voice-overs and voice profiles (M5 design package §11). The worker runs jobs. */
@Controller()
export class MediaController {
  constructor(
    private readonly videos: VideosService,
    private readonly voiceovers: VoiceoversService,
    private readonly profiles: VoiceProfilesService,
  ) {}

  // ------------------------------------------------------------------- clips

  @Post('storyboards/:storyboardVersionId/videos/estimate')
  @HttpCode(200)
  @Endpoint({
    summary: 'Plan and price clips for scenes with a keyframe (no cost)',
    tags: ['videos'],
    params: storyboardVersionIdParamsSchema,
    body: videoGenerationRequestSchema,
    responses: { 200: { description: 'Per-scene plan and estimate', schema: videoEstimateSchema } },
    errors: [400, 401, 404, 409, 422],
  })
  estimateVideos(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
    @ValidBody() body: VideoGenerationRequest,
  ): Promise<VideoEstimateDto> {
    return this.videos.estimate(actor, params.storyboardVersionId, body);
  }

  @Post('storyboards/:storyboardVersionId/videos/generate')
  @HttpCode(202)
  @Endpoint({
    summary: 'Queue one clip job per scene (editor); needs the confirmed estimate',
    tags: ['videos'],
    params: storyboardVersionIdParamsSchema,
    body: videoGenerationRequestSchema,
    responses: { 202: { description: 'Queued', schema: videoGenerateResponseSchema } },
    errors: [400, 401, 403, 404, 409, 422, 503],
  })
  generateVideos(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
    @ValidBody() body: VideoGenerationRequest,
  ): Promise<VideoGenerateResponseDto> {
    return this.videos.generate(actor, params.storyboardVersionId, body);
  }

  @Get('storyboards/:storyboardVersionId/videos')
  @Endpoint({
    summary: 'Keyframes, clips, candidates, jobs and provider progress of every scene',
    tags: ['videos'],
    params: storyboardVersionIdParamsSchema,
    responses: { 200: { description: 'Scene clips', schema: storyboardVideosSchema } },
    errors: [400, 401, 404],
  })
  viewVideos(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
  ): Promise<StoryboardVideosDto> {
    return this.videos.view(actor, params.storyboardVersionId);
  }

  @Put('scenes/:sceneId/clip')
  @Endpoint({
    summary: "Select an approved clip as the scene's clip (editor)",
    tags: ['videos'],
    params: sceneIdParamsSchema,
    body: selectSceneMediaRequestSchema,
    responses: { 200: { description: 'Scene clips', schema: storyboardVideosSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  setClip(
    @CurrentActor() actor: Actor,
    @ValidParams() params: SceneParams,
    @ValidBody() body: SelectSceneMediaRequest,
  ): Promise<StoryboardVideosDto> {
    return this.videos.setClip(actor, params.sceneId, body.assetId);
  }

  @Post('generation-jobs/:jobId/recheck')
  @HttpCode(202)
  @Endpoint({
    summary: 'Check a running video job at the provider now (editor; free, never resubmits)',
    tags: ['videos'],
    params: jobIdParamsSchema,
    responses: { 202: { description: 'Status read queued', schema: generationJobSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  recheck(
    @CurrentActor() actor: Actor,
    @ValidParams() params: JobParams,
  ): Promise<GenerationJobDto> {
    return this.videos.recheck(actor, params.jobId);
  }

  // ------------------------------------------------------------------- voice-overs

  @Post('storyboards/:storyboardVersionId/voiceovers/estimate')
  @HttpCode(200)
  @Endpoint({
    summary: 'Plan and price voice-overs for scenes with voice-over text (no cost)',
    tags: ['voiceovers'],
    params: storyboardVersionIdParamsSchema,
    body: voiceoverGenerationRequestSchema,
    responses: {
      200: { description: 'Per-scene plan and estimate', schema: voiceoverEstimateSchema },
    },
    errors: [400, 401, 404, 409, 422],
  })
  estimateVoiceovers(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
    @ValidBody() body: VoiceoverGenerationRequest,
  ): Promise<VoiceoverEstimateDto> {
    return this.voiceovers.estimate(actor, params.storyboardVersionId, body);
  }

  @Post('storyboards/:storyboardVersionId/voiceovers/generate')
  @HttpCode(202)
  @Endpoint({
    summary: "Queue one voice-over job per scene with the content item's voice profile (editor)",
    tags: ['voiceovers'],
    params: storyboardVersionIdParamsSchema,
    body: voiceoverGenerationRequestSchema,
    responses: { 202: { description: 'Queued', schema: voiceoverGenerateResponseSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  generateVoiceovers(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
    @ValidBody() body: VoiceoverGenerationRequest,
  ): Promise<VoiceoverGenerateResponseDto> {
    return this.voiceovers.generate(actor, params.storyboardVersionId, body);
  }

  @Get('storyboards/:storyboardVersionId/voiceovers')
  @Endpoint({
    summary: 'Voice-overs, candidates and jobs of every scene',
    tags: ['voiceovers'],
    params: storyboardVersionIdParamsSchema,
    responses: { 200: { description: 'Scene voice-overs', schema: storyboardVoiceoversSchema } },
    errors: [400, 401, 404],
  })
  viewVoiceovers(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
  ): Promise<StoryboardVoiceoversDto> {
    return this.voiceovers.view(actor, params.storyboardVersionId);
  }

  @Put('scenes/:sceneId/voiceover')
  @Endpoint({
    summary: 'Select an approved voice-over (generated or imported) for the scene (editor)',
    tags: ['voiceovers'],
    params: sceneIdParamsSchema,
    body: selectSceneMediaRequestSchema,
    responses: { 200: { description: 'Scene voice-overs', schema: storyboardVoiceoversSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  setVoiceover(
    @CurrentActor() actor: Actor,
    @ValidParams() params: SceneParams,
    @ValidBody() body: SelectSceneMediaRequest,
  ): Promise<StoryboardVoiceoversDto> {
    return this.voiceovers.setVoiceover(actor, params.sceneId, body.assetId);
  }

  // ------------------------------------------------------------------- voice profiles

  @Get('projects/:projectId/voice-profiles')
  @Endpoint({
    summary: "List the project's voice profiles",
    tags: ['voice-profiles'],
    params: projectIdParamsSchema,
    query: listVoiceProfilesQuerySchema,
    responses: { 200: { description: 'Voice profiles', schema: voiceProfileListSchema } },
    errors: [400, 401, 404],
  })
  listProfiles(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: ProfileQuery,
  ): Promise<VoiceProfileListDto> {
    return this.profiles.list(actor, params.projectId, query.includeArchived);
  }

  @Post('projects/:projectId/voice-profiles')
  @Endpoint({
    summary: 'Create a voice profile (editor)',
    tags: ['voice-profiles'],
    params: projectIdParamsSchema,
    body: createVoiceProfileRequestSchema,
    responses: { 201: { description: 'Created', schema: voiceProfileSchema } },
    errors: [400, 401, 403, 404, 422],
  })
  createProfile(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: CreateVoiceProfileRequest,
  ): Promise<VoiceProfileDto> {
    return this.profiles.create(actor, params.projectId, body);
  }

  @Patch('voice-profiles/:voiceProfileId')
  @Endpoint({
    summary: 'Edit a voice profile (editor); past voice-overs keep their parameters',
    tags: ['voice-profiles'],
    params: voiceProfileIdParamsSchema,
    body: updateVoiceProfileRequestSchema,
    responses: { 200: { description: 'Updated', schema: voiceProfileSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  updateProfile(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProfileParams,
    @ValidBody() body: UpdateVoiceProfileRequest,
  ): Promise<VoiceProfileDto> {
    return this.profiles.update(actor, params.voiceProfileId, body);
  }

  @Post('voice-profiles/:voiceProfileId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive a voice profile (editor)',
    tags: ['voice-profiles'],
    params: voiceProfileIdParamsSchema,
    responses: { 200: { description: 'Archived', schema: voiceProfileSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archiveProfile(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProfileParams,
  ): Promise<VoiceProfileDto> {
    return this.profiles.archive(actor, params.voiceProfileId);
  }
}
