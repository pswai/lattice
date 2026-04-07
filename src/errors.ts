import type { ApiError } from './models/types.js';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON(): ApiError {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

export class SecretDetectedError extends AppError {
  constructor(pattern: string, matchPreview: string) {
    super('SECRET_DETECTED', 422, 'Content blocked: potential secret detected. Remove the sensitive value before saving.', {
      pattern,
      match_preview: matchPreview,
    });
  }
}

export class TaskConflictError extends AppError {
  constructor(currentVersion: number, yourVersion: number) {
    super('TASK_CONFLICT', 409, 'Task was modified by another agent. Fetch the latest version and retry.', {
      current_version: currentVersion,
      your_version: yourVersion,
    });
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSITION', 400, `Cannot transition task from '${from}' to '${to}'.`, {
      from,
      to,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: number | string) {
    super('NOT_FOUND', 404, `${resource} with id '${id}' not found.`);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super('FORBIDDEN', 403, message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', 400, message, details);
  }
}
