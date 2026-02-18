// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

import { invariant } from '@likec4/core'
import * as z from 'zod/v3'
import { likec4Tool } from '../utils'
import { projectIdSchema } from './_common'

export const findRelationshipPaths = likec4Tool({
  name: 'find-relationship-paths',
  description: `
Discover all paths (chains of relationships) between two elements, supporting multi-hop traversal.

Request:
- sourceId: string — source element FQN
- targetId: string — target element FQN
- maxDepth: number (optional, default: 3, max: 5) — maximum path length (number of hops)
- project: string (optional) — project id. Defaults to "default" if omitted.

Algorithm:
- Uses breadth-first search (BFS) to find all paths
- Prevents cycles with visited set per path
- Paths are sorted by length (shortest first)
- Limited to 100 paths to avoid overwhelming responses

Response (JSON array):
Array of paths, each with:
- length: number — number of hops in the path
- steps: Array<Step> — ordered sequence of relationships

Step (object) fields:
- source: string — source element FQN
- target: string — target element FQN
- relationship: object
  - kind: string|null — relationship kind
  - title: string|null — relationship title
  - description: string|null — relationship description
  - technology: string|null — relationship technology
  - tags: string[] — relationship tags

Notes:
- Read-only, idempotent, no side effects.
- Safe to call repeatedly.
- Returns empty array if no paths exist.
- Rejects if source equals target.
- Rejects if source is ancestor/descendant of target (no relationship paths possible).
- maxDepth is capped at 5 to prevent excessive computation.
- Paths are discovered iteratively and sorted by length.

Example response:
[
  {
    "length": 1,
    "steps": [
      {
        "source": "shop.frontend",
        "target": "shop.backend",
        "relationship": {
          "kind": "uses",
          "title": "Calls API",
          "description": null,
          "technology": "HTTPS",
          "tags": []
        }
      }
    ]
  },
  {
    "length": 2,
    "steps": [
      {
        "source": "shop.frontend",
        "target": "shop.cache",
        "relationship": {
          "kind": "uses",
          "title": "Reads from",
          "description": null,
          "technology": "Redis",
          "tags": []
        }
      },
      {
        "source": "shop.cache",
        "target": "shop.backend",
        "relationship": {
          "kind": "syncs-with",
          "title": "Updates",
          "description": null,
          "technology": null,
          "tags": []
        }
      }
    ]
  }
]
`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    title: 'Find relationship paths',
  },
  inputSchema: {
    sourceId: z.string().describe('Source element FQN'),
    targetId: z.string().describe('Target element FQN'),
    maxDepth: z.number().int().min(1).max(5).optional().default(3).describe(
      'Maximum path length (default: 3, max: 5)',
    ),
    project: projectIdSchema,
  },
  outputSchema: {
    paths: z.array(z.object({
      length: z.number().describe('Number of hops in the path'),
      steps: z.array(z.object({
        source: z.string().describe('Source element FQN'),
        target: z.string().describe('Target element FQN'),
        relationship: z.object({
          kind: z.string().nullable().describe('Relationship kind'),
          title: z.string().nullable().describe('Relationship title'),
          description: z.string().nullable().describe('Relationship description'),
          technology: z.string().nullable().describe('Relationship technology'),
          tags: z.array(z.string()).describe('Relationship tags'),
        }),
      })).describe('Ordered sequence of relationships in the path'),
    })),
  },
}, async (languageServices, args) => {
  const projectId = languageServices.projectsManager.ensureProjectId(args.project)
  const model = await languageServices.computedModel(projectId)

  // Validate source and target exist
  const source = model.findElement(args.sourceId)
  invariant(source, `Source element "${args.sourceId}" not found in project "${projectId}"`)

  const target = model.findElement(args.targetId)
  invariant(target, `Target element "${args.targetId}" not found in project "${projectId}"`)

  // Validate source and target are different
  invariant(source.id !== target.id, 'Source and target must be different elements')

  // Validate source and target are not parent-child (no relationship paths possible)
  invariant(
    !source.isAncestorOf(target) && !target.isAncestorOf(source),
    'Source and target cannot be in parent-child relationship (no relationship paths possible)',
  )

  // Cap maxDepth at 5
  const maxDepth = Math.min(args.maxDepth ?? 3, 5)
  const maxPaths = 100

  // BFS to find all paths
  type PathStep = {
    source: string
    target: string
    relationship: {
      kind: string | null
      title: string | null
      description: string | null
      technology: string | null
      tags: string[]
    }
  }

  type PathNode = {
    elementId: string
    path: PathStep[]
    visited: Set<string>
  }

  const queue: PathNode[] = [{
    elementId: source.id,
    path: [],
    visited: new Set([source.id]),
  }]

  const foundPaths: Array<{
    length: number
    steps: PathStep[]
  }> = []

  while (queue.length > 0 && foundPaths.length < maxPaths) {
    const current = queue.shift()!

    // Check if we've reached max depth
    if (current.path.length >= maxDepth) {
      continue
    }

    // Get current element
    const currentElement = model.findElement(current.elementId)
    if (!currentElement) continue

    // Explore outgoing relationships
    for (const rel of currentElement.outgoing()) {
      const nextId = rel.target.id

      // Check if we've reached the target
      if (nextId === target.id) {
        // Found a path! Store the relationship details immediately
        const pathStep: PathStep = {
          source: rel.source.id,
          target: rel.target.id,
          relationship: {
            kind: rel.kind,
            title: rel.title,
            description: rel.description.text,
            technology: rel.technology,
            tags: [...rel.tags],
          },
        }

        foundPaths.push({
          length: current.path.length + 1,
          steps: [...current.path, pathStep],
        })

        continue
      }

      // Check if we've already visited this element in this path (cycle prevention)
      if (current.visited.has(nextId)) {
        continue
      }

      // Add to queue for further exploration, storing relationship details immediately
      const pathStep: PathStep = {
        source: rel.source.id,
        target: rel.target.id,
        relationship: {
          kind: rel.kind,
          title: rel.title,
          description: rel.description.text,
          technology: rel.technology,
          tags: [...rel.tags],
        },
      }

      queue.push({
        elementId: nextId,
        path: [...current.path, pathStep],
        visited: new Set([...current.visited, nextId]),
      })
    }
  }

  // Sort paths by length (shortest first)
  foundPaths.sort((a, b) => a.length - b.length)

  return { paths: foundPaths }
})
