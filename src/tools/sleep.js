/**
 * Sleep tools - sleep, wake
 */

import { text, error } from '../utils/helpers.js'

export const tools = [
  {
    name: 'sleep',
    description: 'Sleep in a bed. Finds nearest bed within range and attempts to sleep. Only works at night or during thunderstorms.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate of bed (optional - finds nearest if not specified)' },
        y: { type: 'number', description: 'Y coordinate of bed' },
        z: { type: 'number', description: 'Z coordinate of bed' }
      }
    }
  },
  {
    name: 'wake',
    description: 'Wake up from sleeping in a bed',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['sleep'] = async (args) => mcp.sleep(args)
  mcp.handlers['wake'] = async () => mcp.wake()
}

export function registerMethods(mcp, Vec3) {
  mcp.sleep = async function({ x, y, z } = {}) {
    this.requireBot()

    let bed
    if (x !== undefined && y !== undefined && z !== undefined) {
      bed = this.bot.blockAt(new Vec3(x, y, z))
      if (!bed || !bed.name.includes('bed')) {
        return error(`No bed found at ${x}, ${y}, ${z}`)
      }
    } else {
      // Find nearest bed
      const bedTypes = Object.values(this.mcData.blocksByName)
        .filter(b => b.name.includes('bed'))
        .map(b => b.id)

      const beds = this.bot.findBlocks({
        matching: bedTypes,
        maxDistance: 16,
        count: 1
      })

      if (beds.length === 0) {
        return error('No bed found within 16 blocks')
      }

      bed = this.bot.blockAt(beds[0])
    }

    try {
      await this.bot.sleep(bed)
      return text(`Sleeping in bed at ${bed.position.x}, ${bed.position.y}, ${bed.position.z}`)
    } catch (err) {
      if (err.message.includes('too far')) {
        return error(`Bed is too far away. Move closer and try again.`)
      } else if (err.message.includes('not night') || err.message.includes('day')) {
        return error(`Cannot sleep: it's not night time or there's no thunderstorm`)
      } else if (err.message.includes('monsters')) {
        return error(`Cannot sleep: there are monsters nearby`)
      }
      return error(`Failed to sleep: ${err.message}`)
    }
  }

  mcp.wake = async function() {
    this.requireBot()

    if (!this.bot.isSleeping) {
      return text('Not currently sleeping')
    }

    try {
      await this.bot.wake()
      return text('Woke up from bed')
    } catch (err) {
      return error(`Failed to wake: ${err.message}`)
    }
  }
}
