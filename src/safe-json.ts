import { getLogger } from './logger.js';

/**
 * Parse JSON with a fallback for corrupt data. Logs a warning on failure
 * instead of crashing the request handler.
 */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    getLogger().warn('safe_json_parse_failed', { raw: raw.slice(0, 200) });
    return fallback;
  }
}
