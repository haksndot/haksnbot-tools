/**
 * Observation tools - get_status, get_body_state, get_block_at, scan_area, find_blocks, get_nearby_entities, get_nearby_players
 */

import { text, json, error } from '../utils/helpers.js'
import { FOOD_ITEMS, ARMOR_SLOT_NAMES, ARMOR_TIERS, HOSTILE_MOBS } from 'haksnbot-guts'

export const tools = [
  {
    name: 'get_status',
    description: 'Get bot status: position, health, food, gamemode, dimension',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_body_state',
    description: 'Get comprehensive bot state for Body agent: position, health, food, hostiles, players, armor, food items, available armor, movement status, time of day, game mode. Designed for single round-trip per tick.',
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
    description: 'Scan visible blocks in a cubic area, returns block counts by type. Only sees blocks visible from bot position (no x-ray).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Center X' },
        y: { type: 'number', description: 'Center Y' },
        z: { type: 'number', description: 'Center Z' },
        radius: { type: 'number', description: 'Scan radius (default 16)', default: 16 }
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
    description: 'Get players within range. Returns username, exact coordinates (x/y/z), distance, gamemode, and ping for each player.',
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
  mcp.handlers['get_body_state'] = () => mcp.getBodyState()
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
    const pf = this.bot.pathfinder
    const status = {
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
      isRaining: this.bot.isRaining,
      isMoving: pf.isMoving(),
      isMining: pf.isMining()
    }
    if (pf.goal) {
      const g = pf.goal
      status.pathGoal = {}
      if (g.x !== undefined) status.pathGoal.x = g.x
      if (g.y !== undefined) status.pathGoal.y = g.y
      if (g.z !== undefined) status.pathGoal.z = g.z
      if (g.rangeSq !== undefined) status.pathGoal.range = Math.round(Math.sqrt(g.rangeSq))
    }
    return json(status)
  }

  mcp.getBodyState = function() {
    this.requireBot()
    const bot = this.bot
    const pos = bot.entity.position

    // Nearby hostiles and players (within 24 blocks)
    const hostiles = []
    const players = []
    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (!e || e === bot.entity) continue
      const dist = e.position.distanceTo(pos)
      if (dist > 24) continue

      if (e.type === 'hostile' || (e.name && HOSTILE_MOBS.has(e.name))) {
        hostiles.push({
          type: e.name,
          distance: Math.round(dist),
          x: Math.round(e.position.x),
          y: Math.round(e.position.y),
          z: Math.round(e.position.z)
        })
      } else if (e.type === 'player' && e.username !== bot.username) {
        players.push({
          name: e.username,
          distance: Math.round(dist),
          x: Math.round(e.position.x),
          y: Math.round(e.position.y),
          z: Math.round(e.position.z)
        })
      }
    }

    // Armor slots
    const armor = {}
    const armorSlots = bot.inventory.slots
    const slotMap = { 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }
    for (const [slot, name] of Object.entries(slotMap)) {
      const item = armorSlots[parseInt(slot)]
      armor[name] = item ? item.name : null
    }

    // Available food in inventory
    const foodItems = bot.inventory.items()
      .filter(i => FOOD_ITEMS.includes(i.name))
      .map(i => ({ name: i.name, count: i.count }))

    // Available unequipped armor in inventory (better than current)
    const availableArmor = []
    for (const item of bot.inventory.items()) {
      for (const [slot, suffixes] of Object.entries(ARMOR_SLOT_NAMES)) {
        if (suffixes.some(s => item.name.endsWith(s)) && armor[slot] !== item.name) {
          availableArmor.push({ name: item.name, slot, count: item.count })
        }
      }
    }

    // Pathfinder status
    const pf = bot.pathfinder
    const isMoving = pf?.isMoving() || false
    const hasGoal = !!pf?.goal

    return json({
      position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      health: Math.round(bot.health),
      food: Math.round(bot.food),
      hostiles: hostiles.slice(0, 5),
      players: players.slice(0, 5),
      armor,
      foodItems: foodItems.slice(0, 5),
      availableArmor: availableArmor.slice(0, 5),
      isMoving,
      hasGoal,
      timeOfDay: bot.time?.timeOfDay ?? 0,
      gameMode: bot.game?.gameMode || 'unknown',
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

  mcp.scanArea = async function({ x, y, z, radius = 16 }) {
    this.requireBot()

    // Cap radius to prevent event-loop stalls that cause keepalive timeouts
    const cappedRadius = Math.min(radius, 16)
    const blocks = {}

    // Helper to get block key with properties
    const getBlockKey = (block) => {
      const properties = block.getProperties()
      let key = block.name
      if (properties && Object.keys(properties).length > 0) {
        const propsStr = Object.entries(properties)
          .map(([k, v]) => `${k}=${v}`)
          .join(',')
        key = `${block.name}[${propsStr}]`
      }
      return key
    }

    // Helper to check if block is transparent (can see/move through)
    const isTransparent = (block) => {
      if (!block) return true
      if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return true
      // Use mineflayer's transparent property if available
      if (block.transparent) return true
      return false
    }

    // Flood-fill visibility from bot position
    // Only returns blocks that are visible (adjacent to reachable air)
    const botPos = this.bot.entity.position.floored()
    const visited = new Set()
    const visibleBlockPositions = new Set()
    const queue = [botPos]

    // Define scan boundaries (cubic area around center)
    const minX = x - cappedRadius, maxX = x + cappedRadius
    const minY = y - cappedRadius, maxY = y + cappedRadius
    const minZ = z - cappedRadius, maxZ = z + cappedRadius

    // BFS flood-fill through transparent blocks
    // Yield to event loop periodically to allow keepalive responses
    let iterations = 0
    const YIELD_EVERY = 500

    while (queue.length > 0) {
      const pos = queue.shift()
      const key = `${pos.x},${pos.y},${pos.z}`

      if (visited.has(key)) continue
      visited.add(key)

      iterations++
      if (iterations % YIELD_EVERY === 0) {
        // Yield to event loop so keepalive packets can be processed
        await new Promise(resolve => setImmediate(resolve))
      }

      const block = this.bot.blockAt(pos)

      if (isTransparent(block)) {
        // This is a transparent block - explore neighbors
        const offsets = [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]]
        for (const [ox, oy, oz] of offsets) {
          const neighborPos = pos.offset(ox, oy, oz)
          const neighborKey = `${neighborPos.x},${neighborPos.y},${neighborPos.z}`

          if (visited.has(neighborKey)) continue

          const neighborBlock = this.bot.blockAt(neighborPos)

          if (isTransparent(neighborBlock)) {
            // Continue flood-fill through transparent blocks
            // But only queue if within extended bounds (allow some exploration outside scan area)
            const extendedRadius = cappedRadius + 10 // Allow pathfinding from nearby
            if (Math.abs(neighborPos.x - x) <= extendedRadius &&
                Math.abs(neighborPos.y - y) <= extendedRadius &&
                Math.abs(neighborPos.z - z) <= extendedRadius) {
              queue.push(neighborPos)
            }
          } else if (neighborBlock) {
            // Solid block adjacent to transparent - it's visible!
            // Only record if within the actual scan area
            if (neighborPos.x >= minX && neighborPos.x <= maxX &&
                neighborPos.y >= minY && neighborPos.y <= maxY &&
                neighborPos.z >= minZ && neighborPos.z <= maxZ) {
              visibleBlockPositions.add(neighborKey)
            }
          }
        }
      }
    }

    // Count the visible blocks
    for (const posKey of visibleBlockPositions) {
      const [bx, by, bz] = posKey.split(',').map(Number)
      const block = this.bot.blockAt(new Vec3(bx, by, bz))
      if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
        const key = getBlockKey(block)
        blocks[key] = (blocks[key] || 0) + 1
      }
    }

    return json({
      center: { x, y, z },
      radius: cappedRadius,
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
