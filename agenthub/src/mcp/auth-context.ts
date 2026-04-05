import { AsyncLocalStorage } from 'async_hooks';
import type { AuthContext } from '../models/types.js';

export const mcpAuthStorage = new AsyncLocalStorage<AuthContext>();

/**
 * Get the current auth context for an MCP request.
 * Throws if called outside of an authenticated MCP request.
 */
export function getMcpAuth(): AuthContext {
  const auth = mcpAuthStorage.getStore();
  if (!auth) {
    throw new Error('MCP auth context not available — request was not authenticated');
  }
  return auth;
}
