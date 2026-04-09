import { EventEmitter } from 'events';
import { getLogger } from '../logger.js';

const eventBus = new EventEmitter();
// All listeners are properly cleaned up (wait_for_* on settle, SSE on disconnect),
// so we can safely allow unlimited listeners. The monitor below alerts on anomalies.
eventBus.setMaxListeners(0);

const LISTENER_WARN_THRESHOLD = 200;
let lastWarnAt = 0;

/** Check listener count and log a warning if it's unexpectedly high. */
export function checkListenerHealth(): { event: number; message: number } {
  const eventCount = eventBus.listenerCount('event');
  const messageCount = eventBus.listenerCount('message');
  const total = eventCount + messageCount;

  if (total > LISTENER_WARN_THRESHOLD && Date.now() - lastWarnAt > 60_000) {
    lastWarnAt = Date.now();
    getLogger().warn('eventbus_high_listener_count', { eventCount, messageCount, total });
  }

  return { event: eventCount, message: messageCount };
}

export { eventBus };
