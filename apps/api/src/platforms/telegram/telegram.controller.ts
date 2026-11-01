import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { parseBody } from '../../auth/auth.validation.js';
import { AuthenticatedTenantGuard } from '../../auth/authenticated-tenant.guard.js';
import type { TenantContextRequest } from '../../auth/tenant-auth-context.js';
import { TELEGRAM_CONNECTION_SERVICE } from '../platforms.tokens.js';
import type { TelegramConnectionService, TenantActor } from './telegram-connection.service.js';
import { connectTelegramSchema, connectionIdSchema } from './telegram.validation.js';

function actorFrom(request: TenantContextRequest): TenantActor {
  const context = request.tenantContext;
  if (!context) throw new UnauthorizedException('Session is missing');
  return { tenantId: context.tenantId, userId: context.userId };
}

@Controller('platforms/telegram/connections')
@UseGuards(AuthenticatedTenantGuard)
export class TelegramController {
  constructor(
    @Inject(TELEGRAM_CONNECTION_SERVICE) private readonly connections: TelegramConnectionService,
  ) {}

  @Get()
  async list(@Req() request: TenantContextRequest) {
    return { connections: await this.connections.list(actorFrom(request)) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async connect(@Body() body: unknown, @Req() request: TenantContextRequest) {
    const { botToken } = parseBody(connectTelegramSchema, body);
    const connection = await this.connections.connect(actorFrom(request), botToken);
    return { connection };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() request: TenantContextRequest) {
    const connectionId = parseBody(connectionIdSchema, id);
    return { connection: await this.connections.get(actorFrom(request), connectionId) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Param('id') id: string, @Req() request: TenantContextRequest) {
    const connectionId = parseBody(connectionIdSchema, id);
    return this.connections.disconnect(actorFrom(request), connectionId);
  }
}
