/**
 * Movement tools - move_to, move_near, follow_player, look_at, stop
 */

import { text, error } from '../utils/helpers.js'

export const tools = [
  {
    name: 'move_to',
    description: 'Pathfind and move to coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X' },
        y: { type: 'number', description: 'Target Y' },
        z: { type: 'number', description: 'Target Z' }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'move_near',
    description: 'Pathfind to within range of coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X' },
        y: { type: 'number', description: 'Target Y' },
        z: { type: 'number', description: 'Target Z' },
        range: { type: 'number', description: 'Stop within this distance', default: 2 }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'follow_player',
    description: 'Follow a player by username',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Player username to follow' },
        distance: { type: 'number', description: 'Follow distance', default: 3 }
      },
      required: ['username']
    }
  },
  {
    name: 'look_at',
    description: 'Turn to look at coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X' },
        y: { type: 'number', description: 'Target Y' },
        z: { type: 'number', description: 'Target Z' }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'stop',
    description: 'Stop current movement/pathfinding',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['move_to'] = (args) => mcp.moveTo(args)
  mcp.handlers['move_near'] = (args) => mcp.moveNear(args)
  mcp.handlers['follow_player'] = async (args) => mcp.followPlayer(args)
  mcp.handlers['look_at'] = async (args) => mcp.lookAt(args)
  mcp.handlers['stop'] = () => mcp.stop()
}

export function registerMethods(mcp, Vec3, Movements, goals) {
  mcp.moveTo = function({ x, y, z }) {
    this.requireBot()
    const movements = new Movements(this.bot, this.mcData)
    movements.canDig = false  // Never break blocks while pathfinding
    movements.canOpenDoors = true  // Allow navigating through doors
    this.bot.pathfinder.setMovements(movements)

    // Non-blocking: start pathfinding and return immediately
    const goal = new goals.GoalBlock(x, y, z)
    this.bot.pathfinder.setGoal(goal)

    const pos = this.bot.entity.position
    return text(`Moving from ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)} to ${x}, ${y}, ${z}. Use get_status to check progress or stop to cancel.`)
  }

  mcp.moveNear = function({ x, y, z, range = 2 }) {
    this.requireBot()
    const movements = new Movements(this.bot, this.mcData)
    movements.canDig = false  // Never break blocks while pathfinding
    movements.canOpenDoors = true  // Allow navigating through doors
    this.bot.pathfinder.setMovements(movements)

    // Non-blocking: start pathfinding and return immediately
    const goal = new goals.GoalNear(x, y, z, range)
    this.bot.pathfinder.setGoal(goal)

    const pos = this.bot.entity.position
    return text(`Moving from ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)} toward ${x}, ${y}, ${z} (within ${range} blocks). Use get_status to check progress or stop to cancel.`)
  }

  mcp.followPlayer = async function({ username, distance = 3 }) {
    this.requireBot()
    const player = this.bot.players[username]
    if (!player?.entity) {
      return error(`Player "${username}" not found or not in range`)
    }

    const movements = new Movements(this.bot, this.mcData)
    movements.canDig = false  // Never break blocks while pathfinding
    movements.canOpenDoors = true  // Allow navigating through doors
    this.bot.pathfinder.setMovements(movements)
    this.bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, distance), true)

    return text(`Following ${username} at distance ${distance}. Use 'stop' to stop following.`)
  }

  mcp.lookAt = async function({ x, y, z }) {
    this.requireBot()
    await this.bot.lookAt(new Vec3(x, y, z))
    return text(`Now looking at ${x}, ${y}, ${z}`)
  }

  mcp.stop = function() {
    this.requireBot()
    this.bot.pathfinder.stop()
    return text('Stopped')
  }
}
