/**
 * Building tools - place_block, break_block
 */

import { text, json, error } from '../utils/helpers.js'
import { checkClaimStatus } from '../utils/claims.js'

export const tools = [
  {
    name: 'place_block',
    description: 'Place a block from inventory at the specified coordinates. The block is placed against an adjacent reference block.',
    inputSchema: {
      type: 'object',
      properties: {
        block_name: { type: 'string', description: 'Name of the block item to place (e.g. cobblestone, oak_planks, dirt)' },
        x: { type: 'number', description: 'X coordinate to place block' },
        y: { type: 'number', description: 'Y coordinate to place block' },
        z: { type: 'number', description: 'Z coordinate to place block' },
        face: { type: 'string', enum: ['top', 'bottom', 'north', 'south', 'east', 'west', 'auto'], description: 'Which face of adjacent block to place against. "auto" finds any valid adjacent block.', default: 'auto' }
      },
      required: ['block_name', 'x', 'y', 'z']
    }
  },
  {
    name: 'break_block',
    description: 'Break/dig a block at the specified coordinates. Optionally equip the best tool first.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate of block to break' },
        y: { type: 'number', description: 'Y coordinate of block to break' },
        z: { type: 'number', description: 'Z coordinate of block to break' },
        equip_best_tool: { type: 'boolean', description: 'Automatically equip the best tool for this block', default: true }
      },
      required: ['x', 'y', 'z']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['place_block'] = async (args) => mcp.placeBlock(args)
  mcp.handlers['break_block'] = async (args) => mcp.breakBlock(args)
}

export function registerMethods(mcp, Vec3) {
  // Helper to find the best tool for breaking a block
  mcp.findBestTool = function(block) {
    const items = this.bot.inventory.items()
    if (items.length === 0) return null

    // Tool effectiveness mapping
    const toolTypes = {
      pickaxe: ['stone', 'cobblestone', 'ore', 'iron_block', 'gold_block', 'diamond_block', 'netherite_block', 'obsidian', 'brick', 'concrete', 'terracotta', 'prismarine', 'purpur', 'quartz', 'sandstone', 'end_stone', 'basalt', 'blackstone', 'deepslate', 'copper', 'amethyst', 'calcite', 'dripstone', 'pointed_dripstone', 'ice', 'packed_ice', 'blue_ice', 'lantern', 'chain', 'iron_bars', 'iron_door', 'iron_trapdoor', 'anvil', 'enchanting_table', 'ender_chest', 'furnace', 'blast_furnace', 'smoker', 'stonecutter', 'grindstone', 'lodestone', 'hopper', 'cauldron', 'brewing_stand', 'bell', 'conduit', 'spawner', 'nether_brick', 'rail', 'powered_rail', 'detector_rail', 'activator_rail'],
      axe: ['wood', 'log', 'planks', 'fence', 'door', 'sign', 'chest', 'barrel', 'crafting_table', 'bookshelf', 'lectern', 'composter', 'ladder', 'scaffolding', 'campfire', 'beehive', 'bee_nest', 'bamboo', 'pumpkin', 'melon', 'jack_o_lantern', 'mushroom_block', 'cocoa', 'jukebox', 'note_block', 'banner', 'loom', 'cartography_table', 'fletching_table', 'smithing_table', 'bed'],
      shovel: ['dirt', 'grass', 'sand', 'gravel', 'clay', 'soul_sand', 'soul_soil', 'mycelium', 'podzol', 'farmland', 'coarse_dirt', 'rooted_dirt', 'mud', 'snow', 'snow_block', 'powder_snow', 'concrete_powder'],
      hoe: ['hay_block', 'target', 'dried_kelp_block', 'sponge', 'wet_sponge', 'leaves', 'sculk', 'sculk_catalyst', 'sculk_sensor', 'sculk_shrieker', 'sculk_vein', 'moss_block', 'moss_carpet', 'nether_wart_block', 'warped_wart_block', 'shroomlight'],
      shears: ['wool', 'cobweb', 'leaves', 'vine', 'glow_lichen']
    }

    // Find which tool type is best for this block
    let bestToolType = null
    for (const [toolType, blockPatterns] of Object.entries(toolTypes)) {
      if (blockPatterns.some(pattern => block.name.includes(pattern))) {
        bestToolType = toolType
        break
      }
    }

    if (!bestToolType) return null

    // Tool material ranking (best to worst)
    const materialRank = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden']

    // Find best tool of the right type
    let bestTool = null
    let bestRank = Infinity

    for (const item of items) {
      if (!item.name.includes(bestToolType)) continue

      for (let i = 0; i < materialRank.length; i++) {
        if (item.name.includes(materialRank[i]) && i < bestRank) {
          bestRank = i
          bestTool = item
          break
        }
      }
    }

    return bestTool
  }

  mcp.placeBlock = async function({ block_name, x, y, z, face = 'auto' }) {
    this.requireBot()

    // Find the block item in inventory
    const blockItem = this.bot.inventory.items().find(i => i.name === block_name)
    if (!blockItem) {
      return error(`Block "${block_name}" not found in inventory`)
    }

    // Equip the block
    try {
      await this.bot.equip(blockItem, 'hand')
    } catch (err) {
      return error(`Failed to equip ${block_name}: ${err.message}`)
    }

    const targetPos = new Vec3(x, y, z)

    // Check if target position is already occupied by a solid block
    const existingBlock = this.bot.blockAt(targetPos)
    if (existingBlock && existingBlock.boundingBox === 'block') {
      return error(`Cannot place block at ${x}, ${y}, ${z} - position is occupied by ${existingBlock.name}`)
    }

    // Define face directions
    const faceMap = {
      top:    { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },   // place on top of block below
      bottom: { offset: new Vec3(0, 1, 0),  face: new Vec3(0, -1, 0) },  // place on bottom of block above
      north:  { offset: new Vec3(0, 0, 1),  face: new Vec3(0, 0, -1) },  // place on north face of block to south
      south:  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },   // place on south face of block to north
      east:   { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },   // place on east face of block to west
      west:   { offset: new Vec3(1, 0, 0),  face: new Vec3(-1, 0, 0) }   // place on west face of block to east
    }

    let referenceBlock = null
    let faceVector = null

    if (face === 'auto') {
      // Try all directions to find a valid reference block
      const directions = ['top', 'bottom', 'north', 'south', 'east', 'west']
      for (const dir of directions) {
        const { offset, face: faceVec } = faceMap[dir]
        const checkPos = targetPos.plus(offset)
        const block = this.bot.blockAt(checkPos)
        if (block && block.boundingBox === 'block') {
          referenceBlock = block
          faceVector = faceVec
          break
        }
      }

      if (!referenceBlock) {
        return error(`No adjacent solid block found to place against at ${x}, ${y}, ${z}`)
      }
    } else {
      // Use specified face
      const faceInfo = faceMap[face]
      if (!faceInfo) {
        return error(`Invalid face: ${face}. Use: top, bottom, north, south, east, west, or auto`)
      }

      const checkPos = targetPos.plus(faceInfo.offset)
      referenceBlock = this.bot.blockAt(checkPos)

      if (!referenceBlock || referenceBlock.boundingBox !== 'block') {
        return error(`No solid block found at ${face} direction to place against`)
      }
      faceVector = faceInfo.face
    }

    // Set up listener to capture GriefPrevention denial messages
    const denialMessages = []
    const onMessage = (jsonMsg) => {
      const msgText = jsonMsg.toString().toLowerCase()
      if (msgText.includes("don't have") && msgText.includes("permission") ||
          msgText.includes("belongs to") ||
          msgText.includes("claimed by") ||
          msgText.includes("claim") && (msgText.includes("can't") || msgText.includes("cannot")) ||
          msgText.includes("not allowed") ||
          msgText.includes("that belongs to")) {
        denialMessages.push(jsonMsg.toString())
      }
    }
    this.bot.on('message', onMessage)

    // Place the block
    try {
      await this.bot.placeBlock(referenceBlock, faceVector)
    } catch (err) {
      this.bot.removeListener('message', onMessage)
      return error(`Failed to place block: ${err.message}`)
    }

    // Wait for the block to be placed and catch any denial messages
    await new Promise(resolve => setTimeout(resolve, 300))
    this.bot.removeListener('message', onMessage)

    // Verify placement
    const placedBlock = this.bot.blockAt(targetPos)
    if (!placedBlock || placedBlock.name === 'air') {
      if (denialMessages.length > 0) {
        const claimInfo = await checkClaimStatus(this.bot)
        const ownerInfo = claimInfo.owner ? ` (owned by ${claimInfo.owner})` : ''
        return error(`Cannot place ${block_name} at ${x}, ${y}, ${z} - protected by claim${ownerInfo}. Message: ${denialMessages[0]}`)
      }
      return error(`Block placement failed - target position is empty`)
    }

    return json({
      success: true,
      block_placed: placedBlock.name,
      position: { x, y, z },
      placed_against: {
        block: referenceBlock.name,
        position: {
          x: referenceBlock.position.x,
          y: referenceBlock.position.y,
          z: referenceBlock.position.z
        }
      }
    })
  }

  mcp.breakBlock = async function({ x, y, z, equip_best_tool = true }) {
    this.requireBot()

    const targetPos = new Vec3(x, y, z)
    const block = this.bot.blockAt(targetPos)

    if (!block) {
      return error(`No block found at ${x}, ${y}, ${z}`)
    }

    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      return error(`No block to break at ${x}, ${y}, ${z} (found: ${block.name})`)
    }

    if (!this.bot.canDigBlock(block)) {
      return error(`Cannot break ${block.name} at ${x}, ${y}, ${z} - block is unbreakable or out of reach`)
    }

    // Optionally equip the best tool
    let toolUsed = null
    if (equip_best_tool) {
      const bestTool = this.findBestTool(block)
      if (bestTool) {
        try {
          await this.bot.equip(bestTool, 'hand')
          toolUsed = bestTool.name
        } catch (err) {
          // Continue without best tool if equip fails
        }
      }
    }

    const digTime = this.bot.digTime(block)

    // Set up listener to capture GriefPrevention denial messages
    const denialMessages = []
    const onMessage = (jsonMsg) => {
      const msgText = jsonMsg.toString().toLowerCase()
      if (msgText.includes("don't have") && msgText.includes("permission") ||
          msgText.includes("belongs to") ||
          msgText.includes("claimed by") ||
          msgText.includes("claim") && (msgText.includes("can't") || msgText.includes("cannot")) ||
          msgText.includes("not allowed") ||
          msgText.includes("that belongs to")) {
        denialMessages.push(jsonMsg.toString())
      }
    }
    this.bot.on('message', onMessage)

    try {
      await this.bot.dig(block)
    } catch (err) {
      this.bot.removeListener('message', onMessage)
      return error(`Failed to break ${block.name}: ${err.message}`)
    }

    // Wait briefly to catch any denial messages from GriefPrevention
    await new Promise(resolve => setTimeout(resolve, 300))
    this.bot.removeListener('message', onMessage)

    // Verify block was broken
    const afterBlock = this.bot.blockAt(targetPos)
    const success = !afterBlock || afterBlock.name === 'air' || afterBlock.name !== block.name

    // If block wasn't broken, check if it's a claim protection issue
    if (!success) {
      if (denialMessages.length > 0) {
        const claimInfo = await checkClaimStatus(this.bot)
        const ownerInfo = claimInfo.owner ? ` (owned by ${claimInfo.owner})` : ''
        return error(`Cannot break ${block.name} at ${x}, ${y}, ${z} - protected by claim${ownerInfo}. Message: ${denialMessages[0]}`)
      }
      return error(`Failed to break ${block.name} at ${x}, ${y}, ${z} - block was not removed (unknown reason)`)
    }

    return json({
      success,
      block_broken: block.name,
      position: { x, y, z },
      tool_used: toolUsed,
      dig_time_ms: digTime
    })
  }
}
