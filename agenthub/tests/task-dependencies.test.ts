import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Task Dependencies', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should create a task with dependencies', async () => {
    // Create prerequisite task
    const prereqRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
      body: { description: 'Run tests', status: 'open' },
    });
    const prereq = await prereqRes.json();

    // Create dependent task
    const depRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
      body: {
        description: 'Deploy to prod',
        status: 'open',
        depends_on: [prereq.task_id],
      },
    });

    expect(depRes.status).toBe(201);
    const dep = await depRes.json();
    expect(dep.task_id).toBeGreaterThan(prereq.task_id);
  });

  it('should block claiming a task whose dependencies are not completed', async () => {
    // Create prerequisite task (open, not completed)
    const prereqRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
      body: { description: 'Build step', status: 'open' },
    });
    const prereq = await prereqRes.json();

    // Create dependent task as open
    const depRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
      body: {
        description: 'Deploy step',
        status: 'open',
        depends_on: [prereq.task_id],
      },
    });
    const dep = await depRes.json();

    // Try to claim the dependent task — should fail
    const claimRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${dep.task_id}`, {
      headers: authHeaders(ctx.apiKey),
      body: { status: 'claimed', version: 1 },
    });

    expect(claimRes.status).toBe(400);
    const error = await claimRes.json();
    expect(error.message).toContain('blocked by');
  });

  it('should allow claiming once dependencies are completed', async () => {
    // Create and complete prerequisite
    const prereqRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
      body: { description: 'Build step' },
    });
    const prereq = await prereqRes.json();

    // Complete the prerequisite
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${prereq.task_id}`, {
      headers: authHeaders(ctx.apiKey),
      body: { status: 'completed', result: 'Build passed', version: 1 },
    });

    // Create dependent task as open
    const depRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
      body: {
        description: 'Deploy step',
        status: 'open',
        depends_on: [prereq.task_id],
      },
    });
    const dep = await depRes.json();

    // Claim the dependent task — should succeed now
    const claimRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${dep.task_id}`, {
      headers: authHeaders(ctx.apiKey),
      body: { status: 'claimed', version: 1 },
    });

    expect(claimRes.status).toBe(200);
  });
});
