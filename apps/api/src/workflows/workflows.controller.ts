import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  createWorkflowSchema,
  listWorkflowsQuerySchema,
  patchWorkflowSchema,
  reorderWorkflowsSchema,
  replaceWorkflowSchema,
  workflowIdSchema,
} from '@chatmaster/shared';
import { parseBody } from '../auth/auth.validation.js';
import { AuthenticatedTenantGuard } from '../auth/authenticated-tenant.guard.js';
import type { TenantContextRequest } from '../auth/tenant-auth-context.js';
import { WORKFLOW_SERVICE } from './workflows.tokens.js';
import type {
  ReorderResult,
  TenantActor,
  WorkflowDetailView,
  WorkflowPage,
  WorkflowService,
} from './workflow.service.js';

interface WorkflowResponse {
  workflow: WorkflowDetailView;
}

function actorFrom(request: TenantContextRequest): TenantActor {
  const context = request.tenantContext;
  if (!context) throw new UnauthorizedException('Session is missing');
  return { tenantId: context.tenantId, userId: context.userId };
}

/**
 * Cookie-authenticated; the global CsrfGuard covers every mutating route and
 * the tenant interceptor wraps each handler in one RLS-scoped transaction.
 */
@Controller('workflows')
@UseGuards(AuthenticatedTenantGuard)
export class WorkflowsController {
  constructor(@Inject(WORKFLOW_SERVICE) private readonly workflows: WorkflowService) {}

  @Get()
  async list(@Query() query: unknown, @Req() request: TenantContextRequest): Promise<WorkflowPage> {
    return this.workflows.list(actorFrom(request), parseBody(listWorkflowsQuerySchema, query));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Req() request: TenantContextRequest,
  ): Promise<WorkflowResponse> {
    const workflow = await this.workflows.create(
      actorFrom(request),
      parseBody(createWorkflowSchema, body),
    );
    return { workflow };
  }

  /** Declared before the `:id` routes; ids are UUID-validated so there is no ambiguity either way. */
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(
    @Body() body: unknown,
    @Req() request: TenantContextRequest,
  ): Promise<ReorderResult> {
    return this.workflows.reorder(actorFrom(request), parseBody(reorderWorkflowsSchema, body));
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() request: TenantContextRequest,
  ): Promise<WorkflowResponse> {
    return {
      workflow: await this.workflows.get(actorFrom(request), parseBody(workflowIdSchema, id)),
    };
  }

  @Put(':id')
  async replace(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: TenantContextRequest,
  ): Promise<WorkflowResponse> {
    const workflowId = parseBody(workflowIdSchema, id);
    const input = parseBody(replaceWorkflowSchema, body);
    return { workflow: await this.workflows.replace(actorFrom(request), workflowId, input) };
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: TenantContextRequest,
  ): Promise<WorkflowResponse> {
    const workflowId = parseBody(workflowIdSchema, id);
    const input = parseBody(patchWorkflowSchema, body);
    return { workflow: await this.workflows.patch(actorFrom(request), workflowId, input) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('id') id: string,
    @Req() request: TenantContextRequest,
  ): Promise<{ id: string }> {
    return this.workflows.delete(actorFrom(request), parseBody(workflowIdSchema, id));
  }
}
