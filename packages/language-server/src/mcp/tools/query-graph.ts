// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

import { invariant } from '@likec4/core'
import * as z from 'zod/v3'
import { likec4Tool } from '../utils'
import { includedInViews, includedInViewsSchema, projectIdSchema } from './_common'

const queryTypeSchema = z.enum([
  'ancestors',
  'descendants',
  'siblings',
  'children',
  'parent',
  'incomers',
  'outgoers',
])

export const queryGraph = likec4Tool({
  name: 'query-graph',
  description: `
Query element hierarchy and relationships in the architecture graph.

Request:
- elementId: string — element id (FQN) to query
- queryType: "ancestors" | "descendants" | "siblings" | "children" | "parent" | "incomers" | "outgoers"
- includeIndirect: boolean (optional, default: true) — for incomers/outgoers, include indirect relationships (through nested elements)
- project: string (optional) — project id. Defaults to "default" if omitted.

Query Types:
- ancestors: Returns all parent elements up to the root (hierarchical)
  Example: shop.frontend.auth.service returns [shop.frontend.auth, shop.frontend, shop]
- descendants: Returns all child elements recursively (hierarchical)
  Example: shop.frontend returns all nested elements like shop.frontend.auth, shop.frontend.auth.service
- siblings: Returns elements at the same hierarchy level with the same parent
  Example: shop.frontend returns [shop.backend, shop.database] if they're siblings
- children: Returns direct child elements only (not recursive)
  Example: shop returns [shop.frontend, shop.backend] but not shop.frontend.auth
- parent: Returns the direct parent element
  Example: shop.frontend.auth returns shop.frontend
- incomers: Returns elements that have outgoing relationships to this element
  includeIndirect=true: Includes relationships to nested children
  Example: Elements that depend on this element
- outgoers: Returns elements that receive incoming relationships from this element
  includeIndirect=true: Includes relationships from nested children
  Example: Elements this element depends on

Response (JSON array):
Array of elements, each with:
- id: string — element id (FQN)
- name: string — element name
- kind: string — element kind
- title: string — human-readable title
- tags: string[] — assigned tags
- metadata: Record<string, string> — element metadata
- includedInViews: View[] — views that include this element

View (object) fields:
- id: string — view identifier
- title: string — view title
- type: "element" | "deployment" | "dynamic"

Notes:
- Read-only, idempotent, no side effects.
- Safe to call repeatedly.
- For parent query on root element, returns empty array.
- For hierarchical queries (ancestors, descendants, siblings, children), includeIndirect is ignored.

Example response:
[
  {
    "id": "shop.frontend",
    "name": "frontend",
    "kind": "container",
    "title": "Frontend",
    "tags": ["public"],
    "metadata": { "owner": "web-team" },
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
    title: 'Query element graph',
  },
  inputSchema: {
    elementId: z.string().describe('Element id (FQN) to query'),
    queryType: queryTypeSchema.describe('Type of graph query'),
    includeIndirect: z.boolean().optional().default(true).describe(
      'For incomers/outgoers: include indirect relationships (default: true)',
    ),
    project: projectIdSchema,
  },
  outputSchema: {
    results: z.array(z.object({
      id: z.string().describe('Element id (FQN)'),
      name: z.string().describe('Element name'),
      kind: z.string().describe('Element kind'),
      title: z.string(),
      tags: z.array(z.string()),
      metadata: z.record(z.union([z.string(), z.array(z.string())])),
      includedInViews: includedInViewsSchema.describe('Views that include this element'),
    })),
  },
}, async (languageServices, args) => {
  const projectId = languageServices.projectsManager.ensureProjectId(args.project)
  const model = await languageServices.computedModel(projectId)
  const element = model.findElement(args.elementId)
  invariant(element, `Element "${args.elementId}" not found in project "${projectId}"`)

  const results = []

  switch (args.queryType) {
    case 'ancestors': {
      // Returns all parent elements up to root (from closest to root)
      for (const ancestor of element.ancestors()) {
        results.push({
          id: ancestor.id,
          name: ancestor.name,
          kind: ancestor.kind,
          title: ancestor.title,
          tags: [...ancestor.tags],
          metadata: ancestor.getMetadata(),
          includedInViews: includedInViews(ancestor.views()),
        })
      }
      break
    }

    case 'descendants': {
      // Returns all child elements recursively
      for (const descendant of element.descendants()) {
        results.push({
          id: descendant.id,
          name: descendant.name,
          kind: descendant.kind,
          title: descendant.title,
          tags: [...descendant.tags],
          metadata: descendant.getMetadata(),
          includedInViews: includedInViews(descendant.views()),
        })
      }
      break
    }

    case 'siblings': {
      // Returns elements at the same hierarchy level
      for (const sibling of element.siblings()) {
        results.push({
          id: sibling.id,
          name: sibling.name,
          kind: sibling.kind,
          title: sibling.title,
          tags: [...sibling.tags],
          metadata: sibling.getMetadata(),
          includedInViews: includedInViews(sibling.views()),
        })
      }
      break
    }

    case 'children': {
      // Returns direct child elements only
      for (const child of element.children()) {
        results.push({
          id: child.id,
          name: child.name,
          kind: child.kind,
          title: child.title,
          tags: [...child.tags],
          metadata: child.getMetadata(),
          includedInViews: includedInViews(child.views()),
        })
      }
      break
    }

    case 'parent': {
      // Returns the direct parent element
      const parent = element.parent
      if (parent) {
        results.push({
          id: parent.id,
          name: parent.name,
          kind: parent.kind,
          title: parent.title,
          tags: [...parent.tags],
          metadata: parent.getMetadata(),
          includedInViews: includedInViews(parent.views()),
        })
      }
      break
    }

    case 'incomers': {
      // Returns elements with outgoing relationships to this element
      const filter = args.includeIndirect ? 'all' : 'direct'
      for (const incomer of element.incomers(filter)) {
        results.push({
          id: incomer.id,
          name: incomer.name,
          kind: incomer.kind,
          title: incomer.title,
          tags: [...incomer.tags],
          metadata: incomer.getMetadata(),
          includedInViews: includedInViews(incomer.views()),
        })
      }
      break
    }

    case 'outgoers': {
      // Returns elements receiving relationships from this element
      const filter = args.includeIndirect ? 'all' : 'direct'
      for (const outgoer of element.outgoers(filter)) {
        results.push({
          id: outgoer.id,
          name: outgoer.name,
          kind: outgoer.kind,
          title: outgoer.title,
          tags: [...outgoer.tags],
          metadata: outgoer.getMetadata(),
          includedInViews: includedInViews(outgoer.views()),
        })
      }
      break
    }
  }

  return { results }
})
