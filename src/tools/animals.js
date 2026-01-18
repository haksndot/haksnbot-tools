/**
 * Animal husbandry tools - interact_entity
 */

import { text, json, error, matchesEntityType } from '../utils/helpers.js'

export const tools = [
  {
    name: 'interact_entity',
    description: 'Interact with an entity using held item (right-click). Use for feeding animals, milking cows, shearing sheep, using leads, trading with villagers.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type to interact with (cow, sheep, pig, horse, villager, etc.)' },
        item_name: { type: 'string', description: 'Item to equip before interacting (wheat, bucket, shears, lead, etc.)' },
        max_distance: { type: 'number', description: 'Max search distance', default: 32 }
      },
      required: ['entity_type']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['interact_entity'] = async (args) => mcp.interactEntity(args)
}

export function registerMethods(mcp, Vec3, Movements, goals) {
  mcp.interactEntity = async function({ entity_type, item_name, max_distance = 32 }) {
    this.requireBot()

    // Find entity using fuzzy matching
    const entity = this.bot.nearestEntity(e =>
      matchesEntityType(e, entity_type) &&
      e.position.distanceTo(this.bot.entity.position) <= max_distance
    )

    if (!entity) {
      return error(`No ${entity_type} found within ${max_distance} blocks`)
    }

    // Equip item if specified
    if (item_name) {
      const item = this.bot.inventory.items().find(i =>
        i.name.toLowerCase().includes(item_name.toLowerCase())
      )
      if (!item) {
        return error(`No ${item_name} in inventory`)
      }
      await this.bot.equip(item, 'hand')
    }

    // Move near entity if too far (need to be within ~3 blocks to interact)
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

    // Interact - use appropriate API based on whether item is involved
    try {
      if (item_name) {
        // useOn is for item-based interactions (feeding, milking, shearing)
        // Note: useOn is synchronous in mineflayer, doesn't return a promise
        this.bot.useOn(entity)
      } else {
        // activateEntity is for pure right-click interactions (trading)
        await this.bot.activateEntity(entity)
      }

      // Wait briefly to catch any denial messages from GriefPrevention
      await new Promise(resolve => setTimeout(resolve, 300))
      this.bot.removeListener('message', onMessage)

      // Check if interaction was denied by claim protection
      if (denialMessages.length > 0) {
        return error(`Interaction blocked: ${denialMessages[0]}`)
      }

      const entityName = entity.name || entity.mobType || entity_type
      return json({
        success: true,
        action: item_name ? 'used_item' : 'activated',
        entity: entityName,
        item: item_name || null,
        position: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        }
      })
    } catch (err) {
      this.bot.removeListener('message', onMessage)
      return error(`Interaction failed: ${err.message}`)
    }
  }
}
