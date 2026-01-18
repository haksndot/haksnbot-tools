/**
 * Inventory tools - get_inventory, get_held_item, equip_item
 */

import { text, json, error } from '../utils/helpers.js'

export const tools = [
  {
    name: 'get_inventory',
    description: 'List items in bot inventory',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_held_item',
    description: 'Get currently held item',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'equip_item',
    description: 'Equip an item by name to hand or armor slot',
    inputSchema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Item name to equip' },
        destination: { type: 'string', description: 'hand, off-hand, head, torso, legs, feet', default: 'hand' }
      },
      required: ['item_name']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['get_inventory'] = () => mcp.getInventory()
  mcp.handlers['get_held_item'] = () => mcp.getHeldItem()
  mcp.handlers['equip_item'] = async (args) => mcp.equipItem(args)
}

export function registerMethods(mcp) {
  mcp.getInventory = function() {
    this.requireBot()
    const items = this.bot.inventory.items()
    if (items.length === 0) {
      return text('Inventory is empty')
    }
    return json(items.map(item => ({
      name: item.name,
      count: item.count,
      slot: item.slot
    })))
  }

  mcp.getHeldItem = function() {
    this.requireBot()
    const item = this.bot.heldItem
    if (!item) {
      return text('Not holding any item')
    }
    return json({
      name: item.name,
      count: item.count
    })
  }

  mcp.equipItem = async function({ item_name, destination = 'hand' }) {
    this.requireBot()
    const item = this.bot.inventory.items().find(i => i.name === item_name)
    if (!item) {
      return error(`Item "${item_name}" not in inventory`)
    }

    try {
      await this.bot.equip(item, destination)
      return text(`Equipped ${item_name} to ${destination}`)
    } catch (err) {
      return error(`Failed to equip: ${err.message}`)
    }
  }
}
