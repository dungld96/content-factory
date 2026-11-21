import { HttpStatus, Injectable } from '@nestjs/common';

import { Capability, ttsConstraintsSchema } from '@acf/ai-core';
import {
  ApiErrorCode,
  type CreateVoiceProfileRequest,
  type UpdateVoiceProfileRequest,
  type VoiceProfileDto,
  type VoiceProfileListDto,
} from '@acf/contracts';
import type { VoiceProfile } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { archived, notFound } from '../common/domain-errors.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';

type Row = VoiceProfile & { model: { modelKey: string } };

export function toVoiceProfileDto(p: Row): VoiceProfileDto {
  return {
    id: p.id,
    projectId: p.projectId,
    name: p.name,
    modelKey: p.model.modelKey,
    voice: p.voice,
    language: p.language,
    speed: p.speed === null ? null : Number(p.speed),
    instructions: p.instructions,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const INCLUDE = { model: { select: { modelKey: true } } } as const;

/**
 * Project voice profiles (M5 design §7.1, decision V7): a TTS model, a provider voice, language,
 * speed and instructions. Jobs snapshot them, so edits never change past voice-overs. Profiles
 * are archived, never deleted.
 */
@Injectable()
export class VoiceProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
  ) {}

  async list(
    actor: Actor,
    projectId: string,
    includeArchived: boolean,
  ): Promise<VoiceProfileListDto> {
    await this.access.require(actor, projectId, 'viewer');
    const rows = await this.prisma.client.voiceProfile.findMany({
      where: { projectId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: INCLUDE,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toVoiceProfileDto) };
  }

  async create(
    actor: Actor,
    projectId: string,
    input: CreateVoiceProfileRequest,
  ): Promise<VoiceProfileDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    const modelId = await this.ttsModel(input.modelKey, input.voice);
    const row = await this.prisma.client.voiceProfile.create({
      data: {
        projectId,
        name: input.name,
        modelId,
        voice: input.voice,
        language: input.language,
        speed: input.speed?.toFixed(2) ?? null,
        instructions: input.instructions ?? null,
        createdById: actor.userId,
      },
      include: INCLUDE,
    });
    return toVoiceProfileDto(row);
  }

  async update(
    actor: Actor,
    voiceProfileId: string,
    input: UpdateVoiceProfileRequest,
  ): Promise<VoiceProfileDto> {
    const current = await this.load(voiceProfileId);
    await this.access.require(actor, current.projectId, 'editor', { mutation: true });
    if (current.archivedAt) throw archived('voice profile');
    const modelKey = input.modelKey ?? current.model.modelKey;
    const voice = input.voice ?? current.voice;
    const modelId =
      input.modelKey !== undefined || input.voice !== undefined
        ? await this.ttsModel(modelKey, voice)
        : current.modelId;
    const row = await this.prisma.client.voiceProfile.update({
      where: { id: voiceProfileId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        modelId,
        voice,
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.speed === undefined ? {} : { speed: input.speed?.toFixed(2) ?? null }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      },
      include: INCLUDE,
    });
    return toVoiceProfileDto(row);
  }

  async archive(actor: Actor, voiceProfileId: string): Promise<VoiceProfileDto> {
    const current = await this.load(voiceProfileId);
    await this.access.require(actor, current.projectId, 'editor', { mutation: true });
    if (current.archivedAt) throw archived('voice profile');
    const row = await this.prisma.client.voiceProfile.update({
      where: { id: voiceProfileId },
      data: { archivedAt: new Date() },
      include: INCLUDE,
    });
    return toVoiceProfileDto(row);
  }

  private async load(voiceProfileId: string): Promise<Row> {
    const row = await this.prisma.client.voiceProfile.findUnique({
      where: { id: voiceProfileId },
      include: INCLUDE,
    });
    if (!row) throw notFound('voice profile');
    return row;
  }

  /** A registered TTS model offering `voice` (when its catalog lists voices). */
  private async ttsModel(modelKey: string, voice: string): Promise<string> {
    const models = await this.prisma.client.aiModel.findMany({
      where: { modelKey, capabilities: { some: { capability: Capability.TTS } } },
      select: { id: true, mediaConstraints: true },
      orderBy: { createdAt: 'asc' },
    });
    const model = models[0];
    if (!model) {
      throw new ApiError({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ApiErrorCode.NoModelRoute,
        message: `No text-to-speech model ${modelKey} is registered.`,
      });
    }
    const constraints = ttsConstraintsSchema.safeParse(model.mediaConstraints);
    if (
      constraints.success &&
      constraints.data.voices.length > 0 &&
      !constraints.data.voices.includes(voice)
    ) {
      throw new ApiError({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ApiErrorCode.ModelLimits,
        message: `The model ${modelKey} does not offer the voice ${voice}.`,
        details: [
          { path: 'voice', message: `offered: ${constraints.data.voices.slice(0, 20).join(', ')}` },
        ],
      });
    }
    return model.id;
  }
}
