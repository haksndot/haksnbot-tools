/**
 * Container tools - open_container, get_container_contents, transfer_items, close_container
 */

import { text, json, error } from '../utils/helpers.js'
import { checkClaimStatus } from '../utils/claims.js'

export const tools = [
  {
    name: 'open_container',
    description: 'Open a container (chest, furnace, etc.) at coordinates and return its contents plus your inventory',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Container X coordinate' },
        y: { type: 'number', description: 'Container Y coordinate' },
        z: { type: 'number', description: 'Container Z coordinate' }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'get_container_contents',
    description: 'Get contents of currently open container (must open_container first)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'transfer_items',
    description: 'Move items between your inventory and an open container',
    inputSchema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Item name to transfer' },
        count: { type: 'number', description: 'Quantity to transfer (default: all available)' },
        direction: { type: 'string', enum: ['to_container', 'to_inventory'], description: 'Transfer direction' },
        target_slot: { type: 'number', description: 'Specific container slot (for furnaces: 0=input, 1=fuel, 2=output)' }
      },
      required: ['item_name', 'direction']
    }
  },
  {
    name: 'close_container',
    description: 'Close the currently open container',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['open_container'] = async (args) => mcp.openContainer(args)
  mcp.handlers['get_container_contents'] = () => mcp.getContainerContents()
  mcp.handlers['transfer_items'] = async (args) => mcp.transferItems(args)
  mcp.handlers['close_container'] = async () => mcp.closeContainer()
}

export function registerMethods(mcp, Vec3) {
  // Container slot layouts for special containers
  mcp.getContainerSlotLayout = function(windowType) {
    const layouts = {
      'minecraft:furnace': {
        type: 'furnace',
        slots: { input: 0, fuel: 1, output: 2 },
        containerSlotCount: 3
      },
      'minecraft:blast_furnace': {
        type: 'blast_furnace',
        slots: { input: 0, fuel: 1, output: 2 },
        containerSlotCount: 3
      },
      'minecraft:smoker': {
        type: 'smoker',
        slots: { input: 0, fuel: 1, output: 2 },
        containerSlotCount: 3
      },
      'minecraft:brewing_stand': {
        type: 'brewing_stand',
        slots: { bottle_0: 0, bottle_1: 1, bottle_2: 2, ingredient: 3, fuel: 4 },
        containerSlotCount: 5
      },
      'minecraft:hopper': {
        type: 'hopper',
        slots: null,
        containerSlotCount: 5
      },
      'minecraft:dispenser': {
        type: 'dispenser',
        slots: null,
        containerSlotCount: 9
      },
      'minecraft:dropper': {
        type: 'dropper',
        slots: null,
        containerSlotCount: 9
      },
      'minecraft:shulker_box': {
        type: 'shulker_box',
        slots: null,
        containerSlotCount: 27
      },
      'minecraft:generic_9x3': {
        type: 'chest',
        slots: null,
        containerSlotCount: 27
      },
      'minecraft:generic_9x6': {
        type: 'double_chest',
        slots: null,
        containerSlotCount: 54
      }
    }
    return layouts[windowType] || { type: 'unknown', slots: null, containerSlotCount: null }
  }

  mcp.openContainer = async function({ x, y, z }) {
    this.requireBot()
    const block = this.bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return error(`No block found at ${x}, ${y}, ${z}`)
    }

    // Check if it's a container block
    const containerBlocks = [
      'chest', 'trapped_chest', 'ender_chest',
      'barrel', 'shulker_box',
      'furnace', 'blast_furnace', 'smoker',
      'hopper', 'dispenser', 'dropper',
      'brewing_stand'
    ]
    // Also match colored shulker boxes
    const isContainer = containerBlocks.some(c => block.name.includes(c))
    if (!isContainer) {
      return error(`Block "${block.name}" at ${x}, ${y}, ${z} is not a container`)
    }

    try {
      // Open the container with a timeout - claimed chests will hang
      const openTimeout = 5000 // 5 seconds
      const openPromise = this.bot.openContainer(block)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), openTimeout)
      )

      const window = await Promise.race([openPromise, timeoutPromise])

      // Get layout info
      const layout = this.getContainerSlotLayout(window.type)

      // Get container items
      const containerItems = window.containerItems().map(item => {
        const slotInfo = { slot: item.slot, name: item.name, count: item.count }
        // Add role info for special containers
        if (layout.slots) {
          for (const [role, slotNum] of Object.entries(layout.slots)) {
            if (item.slot === slotNum) {
              slotInfo.role = role
              break
            }
          }
        }
        return slotInfo
      })

      // Get inventory items
      const inventoryItems = this.bot.inventory.items().map(item => ({
        slot: item.slot,
        name: item.name,
        count: item.count
      }))

      return json({
        container_type: layout.type,
        block_name: block.name,
        position: { x, y, z },
        window_type: window.type,
        slot_layout: layout.slots,
        container_slot_count: layout.containerSlotCount || window.containerItems().length,
        container_items: containerItems,
        inventory: inventoryItems
      })
    } catch (err) {
      // If timeout or other failure, check if it's a claimed container
      if (err.message === 'TIMEOUT' || err.message.includes('timeout')) {
        // Check claim status
        const claimInfo = await checkClaimStatus(this.bot)

        return json({
          error: 'container_access_denied',
          message: `Cannot open container at ${x}, ${y}, ${z} - likely protected by a claim`,
          block_name: block.name,
          position: { x, y, z },
          claim_info: claimInfo
        })
      }

      return error(`Failed to open container: ${err.message}`)
    }
  }

  mcp.getContainerContents = function() {
    this.requireBot()
    const window = this.bot.currentWindow
    if (!window) {
      return error('No container is currently open. Use open_container first.')
    }

    const layout = this.getContainerSlotLayout(window.type)

    const containerItems = window.containerItems().map(item => {
      const slotInfo = { slot: item.slot, name: item.name, count: item.count }
      if (layout.slots) {
        for (const [role, slotNum] of Object.entries(layout.slots)) {
          if (item.slot === slotNum) {
            slotInfo.role = role
            break
          }
        }
      }
      return slotInfo
    })

    const inventoryItems = this.bot.inventory.items().map(item => ({
      slot: item.slot,
      name: item.name,
      count: item.count
    }))

    return json({
      container_type: layout.type,
      window_type: window.type,
      slot_layout: layout.slots,
      container_items: containerItems,
      inventory: inventoryItems
    })
  }

  mcp.transferItems = async function({ item_name, count, direction, target_slot }) {
    this.requireBot()
    const window = this.bot.currentWindow
    if (!window) {
      return error('No container is currently open. Use open_container first.')
    }

    const itemType = this.mcData.itemsByName[item_name]
    if (!itemType) {
      return error(`Unknown item: ${item_name}`)
    }

    try {
      if (direction === 'to_container') {
        // Find item in inventory
        const item = this.bot.inventory.items().find(i => i.name === item_name)
        if (!item) {
          return error(`Item "${item_name}" not in inventory`)
        }

        const transferCount = count || item.count

        if (target_slot !== undefined) {
          // Transfer to specific slot (for furnaces, etc.)
          const invItem = window.slots.find(s => s && s.name === item_name && s.slot >= window.inventoryStart)
          if (!invItem) {
            return error(`Item "${item_name}" not found in window inventory slots`)
          }
          await this.bot.clickWindow(invItem.slot, 0, 0) // Pick up item
          await this.bot.clickWindow(target_slot, 0, 0) // Place in target slot
          // If we have leftovers, put them back
          if (this.bot.heldItem) {
            await this.bot.clickWindow(invItem.slot, 0, 0)
          }
          return text(`Moved ${item_name} to container slot ${target_slot}`)
        } else {
          // Use window.deposit() which handles slot mapping correctly
          await window.deposit(itemType.id, null, transferCount)
          return text(`Moved ${transferCount}x ${item_name} to container`)
        }
      } else if (direction === 'to_inventory') {
        // Find item in container
        const containerItems = window.containerItems()
        const item = containerItems.find(i => i.name === item_name)
        if (!item) {
          return error(`Item "${item_name}" not in container`)
        }

        const transferCount = count || item.count

        // Use window.withdraw() which handles slot mapping correctly
        await window.withdraw(itemType.id, null, transferCount)
        return text(`Moved ${transferCount}x ${item_name} to inventory`)
      } else {
        return error(`Invalid direction: ${direction}. Use 'to_container' or 'to_inventory'`)
      }
    } catch (err) {
      return error(`Transfer failed: ${err.message}`)
    }
  }

  mcp.closeContainer = async function() {
    this.requireBot()
    const window = this.bot.currentWindow
    if (!window) {
      return text('No container is currently open')
    }

    try {
      this.bot.closeWindow(window)
      return text('Container closed')
    } catch (err) {
      return error(`Failed to close container: ${err.message}`)
    }
  }
}
