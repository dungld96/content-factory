import { Controller, Get, Headers, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  ApiErrorCode,
  briefValidationSchema,
  contentIdParamsSchema,
  editSceneRequestSchema,
  editScriptRequestSchema,
  generateRequestSchema,
  generateResponseSchema,
  generationJobDetailSchema,
  jobIdParamsSchema,
  listArtifactVersionsQuerySchema,
  pageSchema,
  productionRunSchema,
  reviewRequestSchema,
  runIdParamsSchema,
  sceneIdParamsSchema,
  scriptVersionIdParamsSchema,
  scriptVersionSchema,
  storyboardVersionDetailSchema,
  storyboardVersionIdParamsSchema,
  storyboardVersionSchema,
  type BriefValidationDto,
  type EditSceneRequest,
  type EditScriptRequest,
  type GenerateRequest,
  type GenerateResponseDto,
  type GenerationJobDetailDto,
  type Page,
  type ProductionRunDto,
  type ReviewRequest,
  type ScriptVersionDto,
  type StoryboardVersionDetailDto,
  type StoryboardVersionDto,
  resumeRunRequestSchema,
  resumeRunResponseSchema,
  type ResumeRunRequest,
  type ResumeRunResponseDto,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { ArtifactsService } from './artifacts.service.js';
import { GenerationService } from './generation.service.js';
import { ResumeService } from './resume.service.js';

type ContentParams = z.infer<typeof contentIdParamsSchema>;
type ScriptParams = z.infer<typeof scriptVersionIdParamsSchema>;
type StoryboardParams = z.infer<typeof storyboardVersionIdParamsSchema>;
type ListQuery = z.output<typeof listArtifactVersionsQuerySchema>;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/** Optional `Idempotency-Key` header: dedupes retries of the same generate request. */
function idempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new ApiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCode.ValidationFailed,
      message: 'The request is invalid.',
      details: [
        { path: 'headers.idempotency-key', message: '8–128 characters of A–Z a–z 0–9 . _ : -' },
      ],
    });
  }
  return value;
}

/** Script and storyboard pipeline (M3 design package §10). Controllers only parse and delegate. */
@Controller()
export class GenerationController {
  constructor(
    private readonly generation: GenerationService,
    private readonly artifacts: ArtifactsService,
    private readonly resume: ResumeService,
  ) {}

  @Post('content/:contentId/brief/validate')
  @HttpCode(200)
  @Endpoint({
    summary: 'Validate the brief (no LLM call)',
    tags: ['generation'],
    params: contentIdParamsSchema,
    responses: {
      200: { description: 'Errors, warnings and claim flags', schema: briefValidationSchema },
    },
    errors: [400, 401, 404],
  })
  validateBrief(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
  ): Promise<BriefValidationDto> {
    return this.generation.validateBrief(actor, params.contentId);
  }

  @Post('content/:contentId/scripts/generate')
  @HttpCode(202)
  @Endpoint({
    summary: 'Generate a script (async job, editor)',
    tags: ['generation'],
    params: contentIdParamsSchema,
    body: generateRequestSchema,
    headers: ['Idempotency-Key'],
    responses: {
      202: {
        description: 'Job accepted, or an identical result reused',
        schema: generateResponseSchema,
      },
    },
    errors: [400, 401, 402, 403, 404, 409, 422],
  })
  generateScript(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
    @ValidBody() body: GenerateRequest,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<GenerateResponseDto> {
    return this.generation.generateScript(actor, params.contentId, body, idempotencyKey(key));
  }

  @Get('content/:contentId/scripts')
  @Endpoint({
    summary: 'List script versions',
    tags: ['scripts'],
    params: contentIdParamsSchema,
    query: listArtifactVersionsQuerySchema,
    responses: { 200: { description: 'Newest first', schema: pageSchema(scriptVersionSchema) } },
    errors: [400, 401, 404],
  })
  listScripts(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
    @ValidQuery() query: ListQuery,
  ): Promise<Page<ScriptVersionDto>> {
    return this.artifacts.listScripts(actor, params.contentId, query);
  }

  @Get('scripts/:scriptVersionId')
  @Endpoint({
    summary: 'Get a script version',
    tags: ['scripts'],
    params: scriptVersionIdParamsSchema,
    responses: { 200: { description: 'The version', schema: scriptVersionSchema } },
    errors: [400, 401, 404],
  })
  getScript(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ScriptParams,
  ): Promise<ScriptVersionDto> {
    return this.artifacts.getScript(actor, params.scriptVersionId);
  }

  @Patch('scripts/:scriptVersionId')
  @HttpCode(201)
  @Endpoint({
    summary: 'Edit a script: creates a new version (editor)',
    tags: ['scripts'],
    params: scriptVersionIdParamsSchema,
    body: editScriptRequestSchema,
    responses: { 201: { description: 'The new version', schema: scriptVersionSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  editScript(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ScriptParams,
    @ValidBody() body: EditScriptRequest,
  ): Promise<ScriptVersionDto> {
    return this.artifacts.editScript(actor, params.scriptVersionId, body);
  }

  @Post('scripts/:scriptVersionId/approve')
  @HttpCode(200)
  @Endpoint({
    summary: 'Approve a script version (gate 1, editor)',
    tags: ['scripts'],
    params: scriptVersionIdParamsSchema,
    responses: { 200: { description: 'Approved', schema: scriptVersionSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  approveScript(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ScriptParams,
  ): Promise<ScriptVersionDto> {
    return this.artifacts.approveScript(actor, params.scriptVersionId);
  }

  @Post('scripts/:scriptVersionId/reject')
  @HttpCode(200)
  @Endpoint({
    summary: 'Reject a script version (editor)',
    tags: ['scripts'],
    params: scriptVersionIdParamsSchema,
    body: reviewRequestSchema,
    responses: { 200: { description: 'Rejected', schema: scriptVersionSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  rejectScript(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ScriptParams,
    @ValidBody() body: ReviewRequest,
  ): Promise<ScriptVersionDto> {
    return this.artifacts.rejectScript(actor, params.scriptVersionId, body);
  }

  @Post('scripts/:scriptVersionId/storyboards/generate')
  @HttpCode(202)
  @Endpoint({
    summary: 'Generate a storyboard from the approved script (async job, editor)',
    tags: ['generation'],
    params: scriptVersionIdParamsSchema,
    body: generateRequestSchema,
    headers: ['Idempotency-Key'],
    responses: {
      202: {
        description: 'Job accepted, or an identical result reused',
        schema: generateResponseSchema,
      },
    },
    errors: [400, 401, 402, 403, 404, 409, 422],
  })
  generateStoryboard(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ScriptParams,
    @ValidBody() body: GenerateRequest,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<GenerateResponseDto> {
    return this.generation.generateStoryboard(
      actor,
      params.scriptVersionId,
      body,
      idempotencyKey(key),
    );
  }

  @Get('content/:contentId/storyboards')
  @Endpoint({
    summary: 'List storyboard versions (with staleness)',
    tags: ['storyboards'],
    params: contentIdParamsSchema,
    query: listArtifactVersionsQuerySchema,
    responses: {
      200: { description: 'Newest first', schema: pageSchema(storyboardVersionSchema) },
    },
    errors: [400, 401, 404],
  })
  listStoryboards(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
    @ValidQuery() query: ListQuery,
  ): Promise<Page<StoryboardVersionDto>> {
    return this.artifacts.listStoryboards(actor, params.contentId, query);
  }

  @Get('storyboards/:storyboardVersionId')
  @Endpoint({
    summary: 'Get a storyboard version with its scenes',
    tags: ['storyboards'],
    params: storyboardVersionIdParamsSchema,
    responses: { 200: { description: 'The version', schema: storyboardVersionDetailSchema } },
    errors: [400, 401, 404],
  })
  getStoryboard(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
  ): Promise<StoryboardVersionDetailDto> {
    return this.artifacts.getStoryboard(actor, params.storyboardVersionId);
  }

  @Patch('scenes/:sceneId')
  @HttpCode(201)
  @Endpoint({
    summary: 'Edit a scene: creates a new storyboard version (editor)',
    tags: ['storyboards'],
    params: sceneIdParamsSchema,
    body: editSceneRequestSchema,
    responses: {
      201: { description: 'The new storyboard version', schema: storyboardVersionDetailSchema },
    },
    errors: [400, 401, 403, 404, 409, 422],
  })
  editScene(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof sceneIdParamsSchema>,
    @ValidBody() body: EditSceneRequest,
  ): Promise<StoryboardVersionDetailDto> {
    return this.artifacts.editScene(actor, params.sceneId, body);
  }

  @Post('storyboards/:storyboardVersionId/approve')
  @HttpCode(200)
  @Endpoint({
    summary: 'Approve a storyboard version (gate 2, editor)',
    tags: ['storyboards'],
    params: storyboardVersionIdParamsSchema,
    responses: { 200: { description: 'Approved', schema: storyboardVersionSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  approveStoryboard(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
  ): Promise<StoryboardVersionDto> {
    return this.artifacts.approveStoryboard(actor, params.storyboardVersionId);
  }

  @Post('storyboards/:storyboardVersionId/reject')
  @HttpCode(200)
  @Endpoint({
    summary: 'Reject a storyboard version (editor)',
    tags: ['storyboards'],
    params: storyboardVersionIdParamsSchema,
    body: reviewRequestSchema,
    responses: { 200: { description: 'Rejected', schema: storyboardVersionSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  rejectStoryboard(
    @CurrentActor() actor: Actor,
    @ValidParams() params: StoryboardParams,
    @ValidBody() body: ReviewRequest,
  ): Promise<StoryboardVersionDto> {
    return this.artifacts.rejectStoryboard(actor, params.storyboardVersionId, body);
  }

  @Get('production-runs/:runId')
  @Endpoint({
    summary: 'Get a production run with its jobs and cost',
    tags: ['generation'],
    params: runIdParamsSchema,
    responses: { 200: { description: 'The run', schema: productionRunSchema } },
    errors: [400, 401, 404],
  })
  getRun(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof runIdParamsSchema>,
  ): Promise<ProductionRunDto> {
    return this.generation.getRun(actor, params.runId);
  }

  @Post('production-runs/:runId/cancel')
  @HttpCode(200)
  @Endpoint({
    summary: 'Cancel queued/running work of a run (editor)',
    tags: ['generation'],
    params: runIdParamsSchema,
    responses: { 200: { description: 'The run after cancel', schema: productionRunSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  cancelRun(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof runIdParamsSchema>,
  ): Promise<ProductionRunDto> {
    return this.generation.cancelRun(actor, params.runId);
  }

  @Post('production-runs/:runId/resume')
  @HttpCode(202)
  @Endpoint({
    summary: 'Request the failed or canceled stages of a run again, in a new linked run (editor)',
    tags: ['generation'],
    params: runIdParamsSchema,
    body: resumeRunRequestSchema,
    responses: {
      202: { description: 'The new run and what was skipped', schema: resumeRunResponseSchema },
    },
    errors: [400, 401, 402, 403, 404, 409, 422, 503],
  })
  resumeRun(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof runIdParamsSchema>,
    @ValidBody() body: ResumeRunRequest,
  ): Promise<ResumeRunResponseDto> {
    return this.resume.resume(actor, params.runId, body);
  }

  @Get('generation-jobs/:jobId')
  @Endpoint({
    summary: 'Get a generation job with its events and cost',
    tags: ['generation'],
    params: jobIdParamsSchema,
    responses: { 200: { description: 'The job', schema: generationJobDetailSchema } },
    errors: [400, 401, 404],
  })
  getJob(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof jobIdParamsSchema>,
  ): Promise<GenerationJobDetailDto> {
    return this.generation.getJob(actor, params.jobId);
  }
}
