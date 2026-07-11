import { z } from 'zod';

// Shared validators used by multiple tool schemas. Defined once here so the
// MCP registration layer (index.ts spreads the exported tool shapes into
// server.tool) and the handler layer (z.object(shape).parse) cannot drift.
export const positiveInt = z.number().int().positive();

export const memoryKey = z.string().regex(/^[a-zA-Z0-9_\-]+$/, 'Key must be alphanumeric with hyphens/underscores only');
