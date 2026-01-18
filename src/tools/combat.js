/**
 * Combat tools - attack_entity, use_item
 */

import { text, error } from '../utils/helpers.js'
import { matchesEntityType } from '../utils/helpers.js'

export const tools = [
  {
    name: 'attack_entity',
    description: 'Attack the nearest entity of a type',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type to attack (e.g. zombie, skeleton)' }
      },
      required: ['entity_type']
    }
  },
  {
    name: 'use_item',
    description: 'Use/activate held item (right-click action)',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['attack_entity'] = async (args) => mcp.attackEntity(args)
  mcp.handlers['use_item'] = async () => mcp.useItem()
}

export function registerMethods(mcp) {
  mcp.attackEntity = async function({ entity_type }) {
    this.requireBot()

    const entity = this.bot.nearestEntity(e =>
      matchesEntityType(e, entity_type)
    )

    if (!entity) {
      return error(`No ${entity_type} found nearby`)
    }

    try {
      await this.bot.attack(entity)
      const dist = Math.floor(entity.position.distanceTo(this.bot.entity.position))
      return text(`Attacked ${entity.name || entity_type} at distance ${dist}`)
    } catch (err) {
      return error(`Failed to attack: ${err.message}`)
    }
  }

  mcp.useItem = async function() {
    this.requireBot()
    const item = this.bot.heldItem
    if (!item) {
      return error('Not holding any item')
    }

    try {
      await this.bot.activateItem()
      return text(`Used ${item.name}`)
    } catch (err) {
      return error(`Failed to use item: ${err.message}`)
    }
  }
}
