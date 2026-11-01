/**
 * HTTP contract for /workflows with a mocked service: route wiring, Zod
 * rejection before the service is reached, and tenant context propagation.
 * Business rules live in workflow.service.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { HttpStatus, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WorkflowsController } from '../src/workflows/workflows.controller.js';
import { WORKFLOW_SERVICE } from '../src/workflows/workflows.tokens.js';
import { AuthenticatedTenantGuard } from '../src/auth/authenticated-tenant.guard.js';
import { AUTH_REPOSITORY, AUTH_SERVICE } from '../src/auth/auth.tokens.js';

const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const CONN_ID = randomUUID();
const WF_ID = randomUUID();

const bypassGuard = {
  canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
    context.switchToHttp().getRequest()['tenantContext'] = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      sessionId: randomUUID(),
      user: { id: USER_ID },
    };
    return true;
  },
};

const service = {
  list: vi.fn(() => Promise.resolve({ items: [], nextCursor: null })),
  get: vi.fn(() => Promise.resolve({ id: WF_ID })),
  create: vi.fn(() => Promise.resolve({ id: WF_ID })),
  replace: vi.fn(() => Promise.resolve({ id: WF_ID })),
  patch: vi.fn(() => Promise.resolve({ id: WF_ID, enabled: false })),
  reorder: vi.fn(() => Promise.resolve({ platformConnectionId: CONN_ID, order: [] })),
  delete: vi.fn(() => Promise.resolve({ id: WF_ID })),
};

const ACTOR = { tenantId: TENANT_ID, userId: USER_ID };

const validBody = {
  platformConnectionId: CONN_ID,
  name: 'Welcome',
  triggers: [{ type: 'START' }],
  replies: [{ key: 'main', text: 'Hi' }],
};

describe('WorkflowsController (HTTP layer)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkflowsController],
      providers: [
        { provide: WORKFLOW_SERVICE, useValue: service },
        { provide: AUTH_SERVICE, useValue: {} },
        { provide: AUTH_REPOSITORY, useValue: {} },
      ],
    })
      .overrideGuard(AuthenticatedTenantGuard)
      .useValue(bypassGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);

  it('GET /workflows parses query params and scopes to the session tenant', async () => {
    await http()
      .get(`/workflows?limit=5&enabled=true&platformConnectionId=${CONN_ID}`)
      .expect(HttpStatus.OK);
    expect(service.list).toHaveBeenCalledWith(ACTOR, {
      limit: 5,
      enabled: true,
      platformConnectionId: CONN_ID,
    });
  });

  it('GET /workflows rejects bad pagination and unknown params', async () => {
    await http().get('/workflows?limit=1000').expect(HttpStatus.BAD_REQUEST);
    await http().get(`/workflows?tenantId=${randomUUID()}`).expect(HttpStatus.BAD_REQUEST);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('POST /workflows creates with 201 and validated input', async () => {
    const response = await http().post('/workflows').send(validBody).expect(HttpStatus.CREATED);
    expect(response.body).toEqual({ workflow: { id: WF_ID } });
    expect(service.create).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ name: 'Welcome', priority: 100 }),
    );
  });

  it('POST /workflows rejects invalid definitions without echoing input', async () => {
    const response = await http()
      .post('/workflows')
      .send({
        ...validBody,
        replies: [
          {
            key: 'main',
            text: 'Hi',
            buttons: [{ row: 0, column: 0, type: 'URL', label: 'x', url: 'javascript:alert(1)' }],
          },
        ],
      })
      .expect(HttpStatus.BAD_REQUEST);
    expect(JSON.stringify(response.body)).not.toContain('javascript');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST /workflows/reorder routes to reorder, not to an :id handler', async () => {
    await http()
      .post('/workflows/reorder')
      .send({ platformConnectionId: CONN_ID, workflowIds: [WF_ID] })
      .expect(HttpStatus.OK);
    expect(service.reorder).toHaveBeenCalledWith(ACTOR, {
      platformConnectionId: CONN_ID,
      workflowIds: [WF_ID],
    });
  });

  it('PATCH /workflows/:id toggles enabled', async () => {
    await http().patch(`/workflows/${WF_ID}`).send({ enabled: false }).expect(HttpStatus.OK);
    expect(service.patch).toHaveBeenCalledWith(ACTOR, WF_ID, { enabled: false });
  });

  it('PUT /workflows/:id refuses to move a workflow between connections', async () => {
    await http().put(`/workflows/${WF_ID}`).send(validBody).expect(HttpStatus.BAD_REQUEST);
    const { platformConnectionId: connection, ...definition } = validBody;
    expect(connection).toBe(CONN_ID);
    await http().put(`/workflows/${WF_ID}`).send(definition).expect(HttpStatus.OK);
    expect(service.replace).toHaveBeenCalledTimes(1);
  });

  it.each(['get', 'delete'] as const)('%s /workflows/:id rejects non-UUID ids', async (method) => {
    await http()[method]('/workflows/not-a-uuid').expect(HttpStatus.BAD_REQUEST);
    expect(service.get).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });

  it('DELETE /workflows/:id returns 200 with the id', async () => {
    const response = await http().delete(`/workflows/${WF_ID}`).expect(HttpStatus.OK);
    expect(response.body).toEqual({ id: WF_ID });
  });
});
