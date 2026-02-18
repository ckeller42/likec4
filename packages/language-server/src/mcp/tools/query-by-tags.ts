// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

import { invariant } from '@likec4/core'
import * as z from 'zod/v3'
import { likec4Tool } from '../utils'
import { includedInViews, includedInViewsSchema, projectIdSchema } from './_common'

export const queryByTags = likec4Tool({
  name: 'query-by-tags',
  description: `
Advanced tag filtering with boolean logic (AND, OR, NOT).

Request:
- allOf: string[] (optional) — element must have ALL these tags (AND logic)
- anyOf: string[] (optional) — element must have ANY of these tags (OR logic)
- noneOf: string[] (optional) — element must have NONE of these tags (NOT logic)
- project: string (optional) — project id. Defaults to "default" if omitted.

Boolean Logic:
- All three conditions are combined with AND logic
- At least one condition must be specified
- Tags are case-sensitive

Example Queries:
- Public APIs: {"allOf": ["public", "api"]}
- Deprecated or legacy: {"anyOf": ["deprecated", "legacy"]}
- Public but not deprecated: {"allOf": ["public"], "noneOf": ["deprecated"]}
- Critical services not in migration: {"allOf": ["critical", "service"], "noneOf": ["migration", "deprecated"]}

Response (JSON array):
Array of matching elements/deployment-nodes, each with:
- id: string — element/node id (FQN)
- name: string — element/node name
- kind: string — element/node kind
- title: string — human-readable title
- tags: string[] — assigned tags (for reference)
- metadata: Record<string, string | string[]> — element metadata
- includedInViews: View[] — views that include this element

View (object) fields:
- id: string — view identifier
- title: string — view title
- type: "element" | "deployment" | "dynamic"

Notes:
- Read-only, idempotent, no side effects.
- Safe to call repeatedly.
- Returns empty array if no matches found.
- Limited to 50 results to avoid overwhelming responses.
- Conflicting conditions (e.g., allOf and noneOf with same tag) will return no results.

Example response:
[
  {
    "id": "shop.api",
    "name": "api",
    "kind": "container",
    "title": "API Gateway",
    "tags": ["public", "api", "critical"],
    "metadata": {
      "owner": "platform-team"
    },
    "includedInViews": [
      {
        "id": "system-overview",
        "title": "System Overview",
        "type": "element"
      }
    ]
  }
]
`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    title: 'Query by tags',
  },
  inputSchema: {
    allOf: z.array(z.string()).optional().describe('Element must have ALL these tags (AND)'),
    anyOf: z.array(z.string()).optional().describe('Element must have ANY of these tags (OR)'),
    noneOf: z.array(z.string()).optional().describe('Element must have NONE of these tags (NOT)'),
    project: projectIdSchema,
  },
  outputSchema: {
    results: z.array(z.object({
      id: z.string().describe('Element/node id (FQN)'),
      name: z.string().describe('Element/node name'),
      kind: z.string().describe('Element/node kind'),
      title: z.string(),
      tags: z.array(z.string()),
      metadata: z.record(z.union([z.string(), z.array(z.string())])),
      includedInViews: includedInViewsSchema.describe('Views that include this element'),
    })),
  },
}, async (languageServices, args) => {
  // Validate that at least one non-empty condition is specified
  invariant(
    (args.allOf && args.allOf.length > 0) ||
      (args.anyOf && args.anyOf.length > 0) ||
      (args.noneOf && args.noneOf.length > 0),
    'At least one condition (allOf, anyOf, or noneOf) must be specified with at least one tag',
  )

  const projectId = languageServices.projectsManager.ensureProjectId(args.project)
  const model = await languageServices.computedModel(projectId)

  const results = []
  const limit = 50

  // Helper function to check if element matches all conditions
  const matchesTags = (tags: Set<string>): boolean => {
    // Check allOf condition (must have ALL tags)
    if (args.allOf && args.allOf.length > 0) {
      const hasAll = args.allOf.every(tag => tags.has(tag))
      if (!hasAll) return false
    }

    // Check anyOf condition (must have AT LEAST ONE tag)
    if (args.anyOf && args.anyOf.length > 0) {
      const hasAny = args.anyOf.some(tag => tags.has(tag))
      if (!hasAny) return false
    }

    // Check noneOf condition (must have NONE of the tags)
    if (args.noneOf && args.noneOf.length > 0) {
      const hasNone = !args.noneOf.some(tag => tags.has(tag))
      if (!hasNone) return false
    }

    return true
  }

  // Search through elements
  for (const element of model.elements()) {
    if (results.length >= limit) break

    const tags = new Set(element.tags)
    if (matchesTags(tags)) {
      results.push({
        id: element.id,
        name: element.name,
        kind: element.kind,
        title: element.title,
        tags: [...element.tags],
        metadata: element.getMetadata(),
        includedInViews: includedInViews(element.views()),
      })
    }
  }

  // Search through deployment nodes (if not at limit yet)
  if (results.length < limit) {
    for (const deploymentElement of model.deployment.elements()) {
      if (results.length >= limit) break

      const tags = new Set(deploymentElement.tags)
      if (matchesTags(tags)) {
        results.push({
          id: deploymentElement.id,
          name: deploymentElement.name,
          kind: deploymentElement.kind,
          title: deploymentElement.title,
          tags: [...deploymentElement.tags],
          metadata: deploymentElement.getMetadata(),
          includedInViews: includedInViews(deploymentElement.views()),
        })
      }
    }
  }

  return { results }
})
