// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

import * as z from 'zod/v3'
import { likec4Tool } from '../utils'
import { includedInViews, includedInViewsSchema, projectIdSchema } from './_common'

const matchModeSchema = z.enum(['exact', 'contains', 'exists'])

export const queryByMetadata = likec4Tool({
  name: 'query-by-metadata',
  description: `
Search elements and deployment nodes by metadata key-value pairs with flexible matching modes.

Request:
- key: string — metadata key to filter by
- value: string (optional) — metadata value to match (ignored for 'exists' mode)
- matchMode: "exact" | "contains" | "exists" (optional, default: "exact")
- project: string (optional) — project id. Defaults to "default" if omitted.

Match Modes:
- exact: Value must match exactly (case-sensitive)
  Example: key="owner", value="platform-team" matches only exact "platform-team"
- contains: Value contains the search string (case-insensitive)
  Example: key="technology", value="aws" matches "AWS Lambda", "aws-s3", etc.
- exists: Element has the key (value parameter is ignored)
  Example: key="owner" returns all elements with any "owner" metadata

Response (JSON array):
Array of matching elements/deployment-nodes, each with:
- id: string — element/node id (FQN)
- name: string — element/node name
- kind: string — element/node kind
- title: string — human-readable title
- tags: string[] — assigned tags
- metadata: Record<string, string | string[]> — all element metadata
- matchedValue: string — the metadata value that matched (for reference)
- includedInViews: View[] — views that include this element

View (object) fields:
- id: string — view identifier
- title: string — view title
- type: "element" | "deployment" | "dynamic"

Notes:
- Read-only, idempotent, no side effects.
- Safe to call repeatedly.
- Handles both string and array metadata values.
- For array values, matches if any element in the array matches.
- Returns empty array if no matches found.
- Limited to 50 results to avoid overwhelming responses.
- Case-sensitive for exact mode, case-insensitive for contains mode.

Example response:
[
  {
    "id": "shop.frontend",
    "name": "frontend",
    "kind": "container",
    "title": "Frontend",
    "tags": ["public"],
    "metadata": {
      "owner": "platform-team",
      "tier": "critical"
    },
    "matchedValue": "platform-team",
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
    title: 'Query by metadata',
  },
  inputSchema: {
    key: z.string().describe('Metadata key to filter by'),
    value: z.string().optional().describe('Metadata value to match (ignored for exists mode)'),
    matchMode: matchModeSchema.optional().default('exact').describe('Matching mode'),
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
      matchedValue: z.string().describe('The metadata value that matched'),
      includedInViews: includedInViewsSchema.describe('Views that include this element'),
    })),
  },
}, async (languageServices, args) => {
  const projectId = languageServices.projectsManager.ensureProjectId(args.project)
  const model = await languageServices.computedModel(projectId)
  const matchMode = args.matchMode ?? 'exact'

  const results = []
  const limit = 50

  // Helper function to check if a value matches based on mode
  const matches = (metadataValue: string | string[], searchValue: string | undefined, mode: string): boolean => {
    const values = Array.isArray(metadataValue) ? metadataValue : [metadataValue]

    switch (mode) {
      case 'exists':
        return true // Key exists, value doesn't matter

      case 'exact':
        if (searchValue === undefined) return false
        return values.some(v => v === searchValue)

      case 'contains':
        if (searchValue === undefined) return false
        const searchLower = searchValue.toLowerCase()
        return values.some(v => v.toLowerCase().includes(searchLower))

      default:
        return false
    }
  }

  // Helper to get the actual matched value for display
  const getMatchedValue = (metadataValue: string | string[], searchValue: string | undefined, mode: string): string => {
    const values = Array.isArray(metadataValue) ? metadataValue : [metadataValue]

    if (mode === 'exists' || searchValue === undefined) {
      return values[0] || ''
    }

    if (mode === 'exact') {
      return values.find(v => v === searchValue) || values[0] || ''
    }

    if (mode === 'contains') {
      const searchLower = searchValue.toLowerCase()
      return values.find(v => v.toLowerCase().includes(searchLower)) || values[0] || ''
    }

    return values[0] || ''
  }

  // Search through elements
  for (const element of model.elements()) {
    if (results.length >= limit) break

    const metadata = element.getMetadata()
    if (args.key in metadata) {
      const metadataValue = metadata[args.key]
      if (metadataValue !== undefined && matches(metadataValue, args.value, matchMode)) {
        results.push({
          id: element.id,
          name: element.name,
          kind: element.kind,
          title: element.title,
          tags: [...element.tags],
          metadata,
          matchedValue: getMatchedValue(metadataValue, args.value, matchMode),
          includedInViews: includedInViews(element.views()),
        })
      }
    }
  }

  // Search through deployment nodes (if not at limit yet)
  if (results.length < limit) {
    for (const deploymentElement of model.deployment.elements()) {
      if (results.length >= limit) break

      const metadata = deploymentElement.getMetadata()
      if (args.key in metadata) {
        const metadataValue = metadata[args.key]
        if (metadataValue !== undefined && matches(metadataValue, args.value, matchMode)) {
          results.push({
            id: deploymentElement.id,
            name: deploymentElement.name,
            kind: deploymentElement.kind,
            title: deploymentElement.title,
            tags: [...deploymentElement.tags],
            metadata,
            matchedValue: getMatchedValue(metadataValue, args.value, matchMode),
            includedInViews: includedInViews(deploymentElement.views()),
          })
        }
      }
    }
  }

  return { results }
})
