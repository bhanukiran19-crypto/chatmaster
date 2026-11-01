import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { PlatformsModule } from './platforms/platforms.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';

@Module({ imports: [AuthModule, PlatformsModule, WebhooksModule, WorkflowsModule] })
export class AppModule {}
