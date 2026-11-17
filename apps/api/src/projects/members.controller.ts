import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  addMemberRequestSchema,
  listSchema,
  memberParamsSchema,
  memberSchema,
  projectIdParamsSchema,
  updateMemberRequestSchema,
  type AddMemberRequest,
  type MemberDto,
  type UpdateMemberRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import { MembersService } from './members.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type MemberParams = z.infer<typeof memberParamsSchema>;

@Controller('projects/:projectId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @Endpoint({
    summary: 'List project members',
    tags: ['members'],
    params: projectIdParamsSchema,
    responses: { 200: { description: 'Members', schema: listSchema(memberSchema) } },
    errors: [400, 401, 404],
  })
  list(@CurrentActor() actor: Actor, @ValidParams() params: ProjectParams) {
    return this.members.list(actor, params.projectId);
  }

  @Post()
  @Endpoint({
    summary: 'Add an existing user by email (owner)',
    tags: ['members'],
    params: projectIdParamsSchema,
    body: addMemberRequestSchema,
    responses: { 201: { description: 'Added', schema: memberSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  add(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: AddMemberRequest,
  ): Promise<MemberDto> {
    return this.members.add(actor, params.projectId, body);
  }

  @Patch(':userId')
  @Endpoint({
    summary: "Change a member's role (owner); a project keeps at least one owner",
    tags: ['members'],
    params: memberParamsSchema,
    body: updateMemberRequestSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Updated', schema: memberSchema } },
    errors: [400, 401, 403, 404, 409, 412, 428],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: MemberParams,
    @ValidBody() body: UpdateMemberRequest,
    @IfMatch() expected: Date | undefined,
  ): Promise<MemberDto> {
    return this.members.updateRole(actor, params.projectId, params.userId, body.role, expected);
  }

  @Delete(':userId')
  @HttpCode(204)
  @Endpoint({
    summary: 'Remove a member (owner); a project keeps at least one owner',
    tags: ['members'],
    params: memberParamsSchema,
    responses: { 204: { description: 'Removed' } },
    errors: [400, 401, 403, 404, 409],
  })
  remove(@CurrentActor() actor: Actor, @ValidParams() params: MemberParams): Promise<void> {
    return this.members.remove(actor, params.projectId, params.userId);
  }
}
