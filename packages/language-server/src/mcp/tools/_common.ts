// SPDX-License-Identifier: MIT
//
// Copyright (c) 2023-2026 Denis Davydkov
// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
//
// Portions of this file have been modified by NVIDIA CORPORATION & AFFILIATES.

import type { LikeC4ViewModel } from '@likec4/core/model'
import type { ProjectId } from '@likec4/core/types'
import { URI } from 'vscode-uri'
import * as z from 'zod/v3'
import type { LikeC4LanguageServices } from '../../LikeC4LanguageServices'
import type { Locate } from '../../protocol'
import { ProjectsManager } from '../../workspace'
import { logger } from '../utils'

/**
 * Schema for serializable project configuration
 * This is a simplified version that omits non-serializable fields like generators
 */
export const projectConfigSchema = z.object({
  name: z.string().describe('Project identifier'),
  title: z.string().optional().describe('Human-readable project title'),
  contactPerson: z.string().optional().describe('Maintainer contact information'),
  metadata: z.record(z.string(), z.any()).optional().describe('Custom project metadata as key-value pairs'),
  extends: z.union([z.string(), z.array(z.string())]).optional().describe('Style inheritance paths'),
  exclude: z.array(z.string()).optional().describe('File exclusion patterns'),
  include: z.object({
    paths: z.array(z.string()).describe('Include paths'),
    maxDepth: z.number().describe('Maximum directory depth'),
    fileThreshold: z.number().describe('File threshold'),
  }).optional().describe('Include configuration'),
  manualLayouts: z.object({
    outDir: z.string().describe('Output directory for manual layouts'),
  }).optional().describe('Manual layouts configuration'),
  styles: z.object({
    hasTheme: z.boolean().describe('Whether theme customization is defined'),
    hasDefaults: z.boolean().describe('Whether default style values are defined'),
    hasCustomCss: z.boolean().describe('Whether custom CSS is defined'),
  }).optional().describe('Simplified styles configuration (boolean flags)'),
})

export type SerializableProjectConfig = z.infer<typeof projectConfigSchema>

/**
 * Serializes project configuration for MCP response
 * Simplifies complex nested structures and omits non-serializable fields
 */
export function serializeConfig(config: any): SerializableProjectConfig {
  const result: any = {
    name: config.name,
  }

  if (config.title) {
    result.title = config.title
  }
  if (config.contactPerson) {
    result.contactPerson = config.contactPerson
  }
  if (config.metadata) {
    result.metadata = config.metadata
  }
  if (config.extends) {
    result.extends = config.extends
  }
  if (config.exclude) {
    result.exclude = config.exclude
  }
  if (config.include) {
    result.include = {
      paths: config.include.paths || [],
      maxDepth: config.include.maxDepth ?? 3,
      fileThreshold: config.include.fileThreshold ?? 30,
    }
  }
  if (config.manualLayouts) {
    result.manualLayouts = {
      outDir: config.manualLayouts.outDir || '.likec4',
    }
  }

  // Simplify styles to boolean flags
  if (config.styles) {
    result.styles = {
      hasTheme: !!config.styles.theme,
      hasDefaults: !!config.styles.defaults,
      hasCustomCss: !!config.styles.customCss,
    }
  }

  // Omit generators (not serializable)

  return result
}

export const locationSchema = z.object({
  path: z.string().describe('Path to the file'),
  range: z.object({
    start: z.object({
      line: z.number(),
      character: z.number(),
    }),
    end: z.object({
      line: z.number(),
      character: z.number(),
    }),
  }).describe('Range in the file'),
}).nullable()

export const projectIdSchema = z.string()
  .refine((_v): _v is ProjectId => true)
  .optional()
  .default(ProjectsManager.DefaultProjectId)
  .describe('Project id (optional, will use "default" if not specified)')

export const includedInViewsSchema = z.array(z.object({
  id: z.string().describe('View id'),
  title: z.string().describe('View title'),
  type: z.enum(['element', 'deployment', 'dynamic']).describe('View type'),
}))

export const includedInViews = (views: Iterable<LikeC4ViewModel>): z.infer<typeof includedInViewsSchema> => {
  return [...views].map(v => ({
    id: v.id,
    title: v.titleOrId,
    type: v.$view._type,
  }))
}

export const mkLocate = (
  languageServices: LikeC4LanguageServices,
  projectId: string,
) =>
(params: Locate.Params): z.infer<typeof locationSchema> => {
  try {
    const loc = languageServices.locate({ projectId, ...params })
    return loc
      ? {
        path: URI.parse(loc.uri).fsPath,
        range: loc.range,
      }
      : null
  } catch (e) {
    logger.debug(`Failed to locate {params}`, { error: e, params })
    return null
  }
}
