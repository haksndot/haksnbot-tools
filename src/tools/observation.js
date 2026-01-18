/**
 * Observation tools - get_status, get_block_at, scan_area, find_blocks, get_nearby_entities, get_nearby_players
 */

import { text, json, error } from '../utils/helpers.js'

export const tools = [
  {
    name: 'get_status',
    description: 'Get bot status: position, health, food, gamemode, dimension',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_block_at',
    description: 'Get block type at specific coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        z: { type: 'number', description: 'Z coordinate' }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'scan_area',
    description: 'Scan blocks in a cubic area, returns block counts by type',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Center X' },
        y: { type: 'number', description: 'Center Y' },
        z: { type: 'number', description: 'Center Z' },
        radius: { type: 'number', description: 'Scan radius (default 5)', default: 5 }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'find_blocks',
    description: 'Find nearest blocks of a specific type',
    inputSchema: {
      type: 'object',
      properties: {
        block_name: { type: 'string', description: 'Block name (e.g. diamond_ore, oak_log)' },
        max_distance: { type: 'number', description: 'Max search distance', default: 64 },
        count: { type: 'number', description: 'Max results to return', default: 10 }
      },
      required: ['block_name']
    }
  },
  {
    name: 'get_nearby_entities',
    description: 'Get entities (mobs, items, etc) within range',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'number', description: 'Search range', default: 32 },
        type: { type: 'string', description: 'Filter by entity type (optional)' }
      }
    }
  },
  {
    name: 'get_nearby_players',
    description: 'Get players within range',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'number', description: 'Search range', default: 100 }
      }
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['get_status'] = () => mcp.getStatus()
  mcp.handlers['get_block_at'] = (args) => mcp.getBlockAt(args)
  mcp.handlers['scan_area'] = (args) => mcp.scanArea(args)
  mcp.handlers['find_blocks'] = (args) => mcp.findBlocks(args)
  mcp.handlers['get_nearby_entities'] = (args) => mcp.getNearbyEntities(args)
  mcp.handlers['get_nearby_players'] = (args) => mcp.getNearbyPlayers(args)
}

export function registerMethods(mcp, Vec3) {
  mcp.getStatus = function() {
    this.requireBot()
    const pos = this.bot.entity.position
    return json({
      position: {
        x: Math.floor(pos.x),
        y: Math.floor(pos.y),
        z: Math.floor(pos.z)
      },
      health: this.bot.health,
      food: this.bot.food,
      gameMode: this.bot.game.gameMode,
      dimension: this.bot.game.dimension,
      time: this.bot.time.day,
      isRaining: this.bot.isRaining
    })
  }

  mcp.getBlockAt = function({ x, y, z }) {
    this.requireBot()
    const block = this.bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return text('Block not loaded or out of range')
    }
    const result = {
      name: block.name,
      type: block.type,
      position: { x, y, z },
      hardness: block.hardness,
      diggable: block.diggable
    }
    // Add block state properties (e.g., age for crops, facing for doors)
    const properties = block.getProperties()
    if (properties && Object.keys(properties).length > 0) {
      result.properties = properties
    }
    return json(result)
  }

  mcp.scanArea = function({ x, y, z, radius = 5 }) {
    this.requireBot()
    const blocks = {}
    const center = new Vec3(x, y, z)

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const block = this.bot.blockAt(center.offset(dx, dy, dz))
          if (block && block.name !== 'air') {
            // Include block state properties in key for meaningful states
            const properties = block.getProperties()
            let key = block.name
            if (properties && Object.keys(properties).length > 0) {
              // Format: blockname[prop1=val1,prop2=val2]
              const propsStr = Object.entries(properties)
                .map(([k, v]) => `${k}=${v}`)
                .join(',')
              key = `${block.name}[${propsStr}]`
            }
            blocks[key] = (blocks[key] || 0) + 1
          }
        }
      }
    }

    return json({
      center: { x, y, z },
      radius,
      blocks
    })
  }

  mcp.findBlocks = function({ block_name, max_distance = 64, count = 10 }) {
    this.requireBot()
    const blockType = this.mcData.blocksByName[block_name]
    if (!blockType) {
      return error(`Unknown block type: ${block_name}`)
    }

    const found = this.bot.findBlocks({
      matching: blockType.id,
      maxDistance: max_distance,
      count
    })

    return json({
      block: block_name,
      found: found.map(pos => {
        const block = this.bot.blockAt(pos)
        const result = {
          x: pos.x,
          y: pos.y,
          z: pos.z,
          distance: Math.floor(pos.distanceTo(this.bot.entity.position))
        }
        // Include block state properties (e.g., age for crops)
        if (block) {
          const properties = block.getProperties()
          if (properties && Object.keys(properties).length > 0) {
            result.properties = properties
          }
        }
        return result
      })
    })
  }

  mcp.getNearbyEntities = function({ range = 32, type }) {
    this.requireBot()
    let entities = Object.values(this.bot.entities)
      .filter(e => e !== this.bot.entity)
      .filter(e => e.position.distanceTo(this.bot.entity.position) <= range)

    if (type) {
      entities = entities.filter(e => e.name === type || e.mobType === type)
    }

    return json(entities.map(e => ({
      name: e.name || e.mobType || e.type,
      type: e.type,
      position: {
        x: Math.floor(e.position.x),
        y: Math.floor(e.position.y),
        z: Math.floor(e.position.z)
      },
      distance: Math.floor(e.position.distanceTo(this.bot.entity.position)),
      health: e.health
    })).sort((a, b) => a.distance - b.distance))
  }

  mcp.getNearbyPlayers = function({ range = 100 }) {
    this.requireBot()
    const players = Object.values(this.bot.players)
      .filter(p => p.entity && p.username !== this.bot.username)
      .map(p => ({
        username: p.username,
        position: {
          x: Math.floor(p.entity.position.x),
          y: Math.floor(p.entity.position.y),
          z: Math.floor(p.entity.position.z)
        },
        distance: Math.floor(p.entity.position.distanceTo(this.bot.entity.position)),
        gamemode: p.gamemode,
        ping: p.ping
      }))
      .filter(p => p.distance <= range)
      .sort((a, b) => a.distance - b.distance)

    return json(players)
  }
}
