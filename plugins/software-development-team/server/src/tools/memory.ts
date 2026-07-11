import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import { memoryKey } from './schemas.js';

const MemoryNamespaceSchema = z.enum(['decisions', 'context', 'learnings', 'reviews', 'reflections']);

// Raw shapes exported for MCP registration — see src/tools/schemas.ts for why
// both validation layers derive from these single definitions.
export const teamMemoryWriteShape = {
  key: memoryKey,
  namespace: MemoryNamespaceSchema,
  value: z.string().min(1),
  runId: z.string().optional(),
};

const TeamMemoryWriteSchema = z.object(teamMemoryWriteShape);

export const teamMemoryReadShape = {
  namespace: MemoryNamespaceSchema.optional(),
  key: memoryKey.optional(),
  search: z.string().optional(),
};

const TeamMemoryReadSchema = z.object(teamMemoryReadShape);

export function handleTeamMemoryWrite(store: MemoryStore, args: unknown) {
  const parsed = TeamMemoryWriteSchema.parse(args);
  const entry = store.write(parsed);
  return { success: true, updatedAt: entry.updatedAt };
}

export function handleTeamMemoryRead(store: MemoryStore, args: unknown) {
  const parsed = TeamMemoryReadSchema.parse(args);
  if (parsed.key && parsed.namespace) {
    const entry = store.read(parsed.namespace, parsed.key);
    return { entry: entry ?? null };
  }
  if (parsed.namespace) {
    const result: Record<string, unknown> = { entries: store.list(parsed.namespace) };
    if (parsed.search) result.searchIgnored = true;
    return result;
  }
  // A key without a namespace can't identify an entry (PK is namespace+key), so
  // it's ignored — surface that explicitly rather than silently.
  if (parsed.search) {
    const result: Record<string, unknown> = { entries: store.search(parsed.search) };
    if (parsed.key) result.keyIgnored = true;
    return result;
  }
  const result: Record<string, unknown> = { entries: store.getAll() };
  if (parsed.key) result.keyIgnored = true;
  return result;
}

export const teamMemoryDeleteShape = {
  namespace: MemoryNamespaceSchema,
  key: memoryKey,
};

const TeamMemoryDeleteSchema = z.object(teamMemoryDeleteShape);

export function handleTeamMemoryDelete(store: MemoryStore, args: unknown) {
  const parsed = TeamMemoryDeleteSchema.parse(args);
  const deleted = store.delete(parsed.namespace, parsed.key);
  return { success: deleted };
}
