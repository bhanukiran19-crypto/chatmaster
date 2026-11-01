import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WorkflowService } from './workflow.service.js';
import { WorkflowsController } from './workflows.controller.js';
import { WORKFLOW_SERVICE } from './workflows.tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [WorkflowsController],
  providers: [{ provide: WORKFLOW_SERVICE, useFactory: () => new WorkflowService() }],
})
export class WorkflowsModule {}
