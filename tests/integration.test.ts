import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Integration — Full End-to-End Flow', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should support full agent collaboration flow', async () => {
    const headersA = authHeaders(ctx.apiKey, 'agent-a');
    const headersB = authHeaders(ctx.apiKey, 'agent-b');

    // Step 1: Agent A saves a learning to context
    const saveRes = await request(ctx.app, 'POST', '/api/v1/context', {
      headers: headersA,
      body: {
        key: 'stripe-idempotency',
        value: 'Use Stripe event ID as idempotency key for webhook processing',
        tags: ['stripe', 'idempotency', 'webhooks'],
      },
    });
    expect(saveRes.status).toBe(201);
    const saveData = await saveRes.json();
    expect(saveData.created).toBe(true);

    // Step 2: Agent A broadcasts the learning
    const broadcastRes = await request(ctx.app, 'POST', '/api/v1/events', {
      headers: headersA,
      body: {
        event_type: 'LEARNING',
        message: 'Discovered Stripe idempotency pattern for webhook handling',
        tags: ['stripe', 'learning'],
      },
    });
    expect(broadcastRes.status).toBe(201);
    const broadcastData = await broadcastRes.json();
    const eventId = broadcastData.event_id;

    // Step 3: Agent B polls for updates and receives the learning
    const pollRes = await request(ctx.app, 'GET', '/api/v1/events', {
      headers: headersB,
    });
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();

    // Should include the broadcast event (and the auto-broadcast from save_context)
    const learningEvents = pollData.events.filter(
      (e: any) => e.eventType === 'LEARNING',
    );
    expect(learningEvents.length).toBeGreaterThanOrEqual(1);

    // Step 4: Agent B queries the context and finds the saved knowledge
    const queryRes = await request(ctx.app, 'GET', '/api/v1/context?query=stripe+idempotency', {
      headers: headersB,
    });
    expect(queryRes.status).toBe(200);
    const queryData = await queryRes.json();
    expect(queryData.entries.length).toBeGreaterThan(0);
    expect(queryData.entries[0].key).toBe('stripe-idempotency');
    expect(queryData.entries[0].createdBy).toBe('agent-a');

    // Step 5: Agent B can also filter by tags
    const tagRes = await request(ctx.app, 'GET', '/api/v1/context?tags=stripe,idempotency', {
      headers: headersB,
    });
    const tagData = await tagRes.json();
    expect(tagData.entries.length).toBeGreaterThan(0);
  });

  it('should support full task lifecycle', async () => {
    const headersA = authHeaders(ctx.apiKey, 'agent-a');
    const headersB = authHeaders(ctx.apiKey, 'agent-b');

    // Agent A creates a task (open, unclaimed)
    const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: headersA,
      body: {
        description: 'Fix webhook idempotency handling',
        status: 'open',
      },
    });
    expect(createRes.status).toBe(201);
    const { task_id } = await createRes.json();

    // Agent B sees the task event
    const eventsRes = await request(ctx.app, 'GET', '/api/v1/events', {
      headers: headersB,
    });
    const eventsData = await eventsRes.json();
    const taskCreated = eventsData.events.find(
      (e: any) => e.eventType === 'TASK_UPDATE' && e.message.includes('Fix webhook'),
    );
    expect(taskCreated).toBeDefined();

    // Agent B claims the task
    const claimRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers: headersB,
      body: { status: 'claimed', version: 1 },
    });
    expect(claimRes.status).toBe(200);

    // Agent B completes the task with a result
    const completeRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers: headersB,
      body: {
        status: 'completed',
        result: 'Added event ID as dedup key in webhook handler',
        version: 2,
      },
    });
    expect(completeRes.status).toBe(200);

    // Agent A can see the completion event
    const cursor = eventsData.cursor;
    const newEventsRes = await request(ctx.app, 'GET', `/api/v1/events?since_id=${cursor}`, {
      headers: headersA,
    });
    const newEvents = await newEventsRes.json();
    const completionEvent = newEvents.events.find(
      (e: any) => e.eventType === 'TASK_UPDATE' && e.message.includes('completed'),
    );
    expect(completionEvent).toBeDefined();

    // Task result is also saved as context
    const contextRes = await request(ctx.app, 'GET', `/api/v1/context?query=dedup`, {
      headers: headersA,
    });
    const contextData = await contextRes.json();
    const taskResult = contextData.entries.find(
      (e: any) => e.key === `task-result-${task_id}`,
    );
    expect(taskResult).toBeDefined();
    expect(taskResult.value).toContain('dedup key');
  });

  it('should support cursor-based event pagination across agents', async () => {
    const headersA = authHeaders(ctx.apiKey, 'agent-a');
    const headersB = authHeaders(ctx.apiKey, 'agent-b');

    // Agent A broadcasts 5 events
    for (let i = 1; i <= 5; i++) {
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers: headersA,
        body: {
          event_type: 'BROADCAST',
          message: `Event ${i}`,
          tags: ['sequence'],
        },
      });
    }

    // Agent B polls with limit 2
    const poll1 = await request(ctx.app, 'GET', '/api/v1/events?limit=2&topics=sequence', {
      headers: headersB,
    });
    const data1 = await poll1.json();
    expect(data1.events.length).toBe(2);
    expect(data1.events[0].message).toBe('Event 1');
    expect(data1.events[1].message).toBe('Event 2');

    // Agent B polls again with cursor
    const poll2 = await request(ctx.app, 'GET', `/api/v1/events?since_id=${data1.cursor}&limit=2&topics=sequence`, {
      headers: headersB,
    });
    const data2 = await poll2.json();
    expect(data2.events.length).toBe(2);
    expect(data2.events[0].message).toBe('Event 3');
    expect(data2.events[1].message).toBe('Event 4');

    // Final poll
    const poll3 = await request(ctx.app, 'GET', `/api/v1/events?since_id=${data2.cursor}&topics=sequence`, {
      headers: headersB,
    });
    const data3 = await poll3.json();
    expect(data3.events.length).toBe(1);
    expect(data3.events[0].message).toBe('Event 5');
  });
});
