// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

import { invariant } from '@likec4/core'
import * as z from 'zod/v3'
import { likec4Tool } from '../utils'
import { includedInViews, includedInViewsSchema, projectIdSchema } from './_common'

export const queryIncomersGraph = likec4Tool({
  name: 'query-incomers-graph',
  description: `
Query the complete graph of all elements that provide input to the target element (recursive incomers/producers).

This tool performs a breadth-first traversal to discover all upstream dependencies - elements that directly or
indirectly provide input to the target element. It returns the complete subgraph in a single response,
making it much more efficient than repeated individual queries.

Request:
- elementId: string — target element id (FQN) to start from
- includeIndirect: boolean (optional, default: true) — include relationships through nested elements
- maxDepth: number (optional, default: 50, max: 100) — maximum traversal depth to prevent infinite recursion
- maxNodes: number (optional, default: 1000, max: 5000) — maximum number of nodes to return
- project: string (optional) — project id. Defaults to "default" if omitted.

Response Structure:
{
  "target": "element.id",
  "totalNodes": number,
  "maxDepth": number,
  "truncated": boolean,
  "nodes": {
    "element.id": {
      "id": "element.id",
      "name": "name",
      "kind": "kind",
      "title": "title",
      "tags": ["tag1", "tag2"],
      "metadata": {},
      "includedInViews": [...],
      "incomers": [
        {
          "elementId": "id1",
          "relationshipLabel": "uses",
          "technology": "REST"
        }
      ],
      "depth": number
    }
  }
}

Use Cases:
- Find all producers/dependencies for an element
- Trace data lineage upstream
- Identify root causes and dependencies
- Build complete dependency trees
- Answer "what feeds into this?" questions

Notes:
- Read-only, idempotent, no side effects
- Cycle detection prevents infinite loops
- Result size limited to maxNodes to prevent huge responses
- If truncated=true, increase maxNodes or reduce maxDepth to get more specific results

Example:
For a database element, this returns all services, APIs, and components that write to it,
plus all their dependencies, recursively up to maxDepth levels.
`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    title: 'Query complete incomers graph',
  },
  inputSchema: {
    elementId: z.string().describe('Target element id (FQN) to query incomers for'),
    includeIndirect: z.boolean().optional().default(true).describe(
      'Include indirect relationships through nested elements (default: true)',
    ),
    maxDepth: z.number().int().positive().max(100).optional().default(50).describe(
      'Maximum traversal depth (default: 50, max: 100)',
    ),
    maxNodes: z.number().int().positive().max(5000).optional().default(1000).describe(
      'Maximum number of nodes to return (default: 1000, max: 5000)',
    ),
    project: projectIdSchema,
  },
  outputSchema: {
    target: z.string().describe('Target element id'),
    totalNodes: z.number().describe('Total number of nodes in the graph'),
    maxDepth: z.number().describe('Maximum depth reached'),
    truncated: z.boolean().describe('True if result was truncated due to maxNodes limit'),
    nodes: z.record(z.object({
      id: z.string().describe('Element id (FQN)'),
      name: z.string().describe('Element name'),
      kind: z.string().describe('Element kind'),
      title: z.string(),
      tags: z.array(z.string()),
      metadata: z.record(z.union([z.string(), z.array(z.string())])),
      includedInViews: includedInViewsSchema,
      incomers: z.array(z.object({
        elementId: z.string().describe('ID of the incoming element'),
        relationshipLabel: z.string().optional().describe('Label on the relationship'),
        technology: z.string().optional().describe('Technology specified on the relationship'),
      })).describe('Incoming relationships with details'),
      depth: z.number().describe('Distance from target element (0 = target)'),
    })),
  },
}, async (languageServices, args) => {
  const projectId = languageServices.projectsManager.ensureProjectId(args.project)
  const model = await languageServices.computedModel(projectId)
  const targetElement = model.findElement(args.elementId)
  invariant(targetElement, `Element "${args.elementId}" not found in project "${projectId}"`)

  const filter = args.includeIndirect ? 'all' : 'direct'
  const maxDepth = Math.min(args.maxDepth, 100)
  const maxNodes = Math.min(args.maxNodes, 5000)
  const visited = new Set<string>()
  const nodes: Record<string, {
    id: string
    name: string
    kind: string
    title: string
    tags: string[]
    metadata: Record<string, string | string[]>
    includedInViews: Array<{ id: string; title: string; type: 'element' | 'deployment' | 'dynamic' }>
    incomers: Array<{
      elementId: string
      relationshipLabel?: string
      technology?: string
    }>
    depth: number
  }> = {}

  let actualMaxDepth = 0
  let truncated = false

  // Use iterative BFS with queue to avoid stack overflow
  const queue: Array<{ elementId: string; depth: number }> = [{ elementId: args.elementId, depth: 0 }]

  while (queue.length > 0) {
    const { elementId, depth } = queue.shift()!

    // Check depth limit
    if (depth > maxDepth) {
      continue
    }

    // Check if already visited
    if (visited.has(elementId)) {
      continue
    }

    // Check node limit
    if (visited.size >= maxNodes) {
      truncated = true
      break
    }

    // Get the element
    const element = model.findElement(elementId)
    if (!element) {
      continue
    }

    // Mark as visited and update depth only after confirming element exists
    visited.add(elementId)
    actualMaxDepth = Math.max(actualMaxDepth, depth)

    // Get incoming relationships
    const incomingRelations = [...element.incoming(filter)]
    const incomersData = incomingRelations.map(rel => {
      const data: {
        elementId: string
        relationshipLabel?: string
        technology?: string
      } = { elementId: rel.source.id }
      if (rel.title) data.relationshipLabel = rel.title
      if (rel.technology) data.technology = rel.technology
      return data
    })

    // Store node data
    nodes[elementId] = {
      id: element.id,
      name: element.name,
      kind: element.kind,
      title: element.title,
      tags: [...element.tags],
      metadata: element.getMetadata(),
      includedInViews: includedInViews(element.views()),
      incomers: incomersData,
      depth,
    }

    // Add incomers to queue for processing
    for (const incomerData of incomersData) {
      if (!visited.has(incomerData.elementId)) {
        queue.push({ elementId: incomerData.elementId, depth: depth + 1 })
      }
    }
  }

  return {
    target: args.elementId,
    totalNodes: visited.size,
    maxDepth: actualMaxDepth,
    truncated,
    nodes,
  }
})
