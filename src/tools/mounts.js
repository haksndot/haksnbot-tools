/**
 * Mount tools - mount_entity, dismount
 */

import { text, json, error, matchesEntityType } from '../utils/helpers.js'

export const tools = [
  {
    name: 'mount_entity',
    description: 'Mount a rideable entity like a horse, pig, boat, or minecart',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type to mount (horse, pig, boat, minecart). Omit to mount nearest rideable.' },
        max_distance: { type: 'number', description: 'Max search distance', default: 32 }
      }
    }
  },
  {
    name: 'dismount',
    description: 'Dismount from current vehicle/mount (horse, boat, minecart, etc.)',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['mount_entity'] = async (args) => mcp.mountEntity(args)
  mcp.handlers['dismount'] = () => mcp.dismount()
}

export function registerMethods(mcp, Vec3, Movements, goals) {
  mcp.mountEntity = async function({ entity_type, max_distance = 32 }) {
    this.requireBot()

    const rideableTypes = ['horse', 'donkey', 'mule', 'pig', 'strider', 'boat', 'minecart', 'camel', 'llama', 'skeleton_horse', 'zombie_horse']

    const entity = this.bot.nearestEntity(e => {
      const inRange = e.position.distanceTo(this.bot.entity.position) <= max_distance
      if (!inRange) return false

      if (entity_type) {
        return matchesEntityType(e, entity_type)
      }
      // Find any rideable entity
      return rideableTypes.some(t => matchesEntityType(e, t))
    })

    if (!entity) {
      const typeMsg = entity_type || 'rideable entity'
      return error(`No ${typeMsg} found within ${max_distance} blocks`)
    }

    // Move near if needed
    const distance = entity.position.distanceTo(this.bot.entity.position)
    if (distance > 3) {
      const movements = new Movements(this.bot, this.mcData)
      movements.canDig = false
      this.bot.pathfinder.setMovements(movements)
      await this.bot.pathfinder.goto(new goals.GoalNear(
        entity.position.x, entity.position.y, entity.position.z, 2
      ))
    }

    // Set up listener to capture GriefPrevention denial messages
    const denialMessages = []
    const onMessage = (jsonMsg) => {
      const msgText = jsonMsg.toString().toLowerCase()
      if (msgText.includes("don't have") && msgText.includes("permission") ||
          msgText.includes("belongs to") ||
          msgText.includes("claimed by") ||
          msgText.includes("claim") && (msgText.includes("can't") || msgText.includes("cannot")) ||
          msgText.includes("not allowed")) {
        denialMessages.push(jsonMsg.toString())
      }
    }
    this.bot.on('message', onMessage)

    try {
      // mount() is synchronous in mineflayer
      this.bot.mount(entity)

      // Wait briefly to catch any denial messages from GriefPrevention
      await new Promise(resolve => setTimeout(resolve, 300))
      this.bot.removeListener('message', onMessage)

      // Check if mount was denied by claim protection
      if (denialMessages.length > 0) {
        return error(`Mount blocked: ${denialMessages[0]}`)
      }

      const entityName = entity.name || entity.mobType || entity_type
      return json({
        success: true,
        mounted: entityName,
        position: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        }
      })
    } catch (err) {
      this.bot.removeListener('message', onMessage)
      return error(`Mount failed: ${err.message}`)
    }
  }

  mcp.dismount = function() {
    this.requireBot()

    if (!this.bot.vehicle) {
      return text('Not currently mounted on anything')
    }

    const vehicleName = this.bot.vehicle.name || this.bot.vehicle.mobType || 'vehicle'
    this.bot.dismount()
    return json({
      success: true,
      dismounted_from: vehicleName
    })
  }
}
