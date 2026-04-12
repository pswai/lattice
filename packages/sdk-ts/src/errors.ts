export class BusRequestTimeoutError extends Error {
  constructor(correlationId: string, timeoutMs: number) {
    super(`request ${correlationId} timed out after ${timeoutMs}ms`);
    this.name = 'BusRequestTimeoutError';
  }
}

export class BusReplayGapError extends Error {
  constructor(from: number, to: number) {
    super(`replay gap: cursors ${from}–${to} may contain undelivered messages`);
    this.name = 'BusReplayGapError';
  }
}

export class BusClosedError extends Error {
  constructor() {
    super('Bus has been closed');
    this.name = 'BusClosedError';
  }
}

export class BusQueueOverflowError extends Error {
  constructor(maxSize: number) {
    super(`message queue overflowed (maxSize=${maxSize})`);
    this.name = 'BusQueueOverflowError';
  }
}

export class BusConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusConnectionError';
  }
}
