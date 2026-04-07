import { EventEmitter } from 'events';

const eventBus = new EventEmitter();
eventBus.setMaxListeners(100); // support many SSE connections

export { eventBus };
