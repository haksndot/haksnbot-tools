/**
 * Villager trading tools - find_villagers, open_villager_trades, trade_with_villager, close_villager_trades
 */

import { text, json, error, matchesEntityType } from '../utils/helpers.js'

export const tools = [
  {
    name: 'find_villagers',
    description: 'Find nearby villagers and wandering traders. Returns their profession, position, and entity ID for trading.',
    inputSchema: {
      type: 'object',
      properties: {
        max_distance: { type: 'number', description: 'Max search distance', default: 32 },
        profession: { type: 'string', description: 'Filter by profession (farmer, librarian, etc.). Omit to find all.' }
      }
    }
  },
  {
    name: 'open_villager_trades',
    description: 'Open a villager or wandering trader\'s trade window and return available trades. Must be within 3 blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'number', description: 'Entity ID of the villager (from find_villagers). If omitted, uses nearest villager.' },
        max_distance: { type: 'number', description: 'Max search distance if no entity_id provided', default: 32 }
      }
    }
  },
  {
    name: 'trade_with_villager',
    description: 'Execute a trade with the currently open villager window. Use open_villager_trades first to see available trades.',
    inputSchema: {
      type: 'object',
      properties: {
        trade_index: { type: 'number', description: 'Index of the trade to execute (0-based, from open_villager_trades output)' },
        times: { type: 'number', description: 'Number of times to execute this trade (default 1)', default: 1 }
      },
      required: ['trade_index']
    }
  },
  {
    name: 'close_villager_trades',
    description: 'Close the currently open villager trading window.',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['find_villagers'] = (args) => mcp.findVillagers(args)
  mcp.handlers['open_villager_trades'] = async (args) => mcp.openVillagerTrades(args)
  mcp.handlers['trade_with_villager'] = async (args) => mcp.tradeWithVillager(args)
  mcp.handlers['close_villager_trades'] = () => mcp.closeVillagerTrades()
}

export function registerMethods(mcp, Vec3, Movements, goals) {
  mcp.getVillagerProfessionName = function(professionId) {
    const professions = {
      0: 'none',
      1: 'armorer',
      2: 'butcher',
      3: 'cartographer',
      4: 'cleric',
      5: 'farmer',
      6: 'fisherman',
      7: 'fletcher',
      8: 'leatherworker',
      9: 'librarian',
      10: 'mason',
      11: 'nitwit',
      12: 'shepherd',
      13: 'toolsmith',
      14: 'weaponsmith'
    }
    return professions[professionId] || 'unknown'
  }

  mcp.findVillagers = function({ max_distance = 32, profession }) {
    this.requireBot()

    const villagerTypes = ['villager', 'wandering_trader']

    const villagers = []
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.position) continue

      const distance = entity.position.distanceTo(this.bot.entity.position)
      if (distance > max_distance) continue

      const isVillager = villagerTypes.some(t => matchesEntityType(entity, t))
      if (!isVillager) continue

      // Get profession from entity metadata if available
      let villagerProfession = 'unknown'
      let villagerLevel = 0
      const isWanderingTrader = matchesEntityType(entity, 'wandering_trader')

      if (isWanderingTrader) {
        villagerProfession = 'wandering_trader'
      } else if (entity.metadata) {
        // Villager data is in metadata index 18 (varies by version)
        // Format: {villagerType, profession, level}
        for (const meta of entity.metadata) {
          if (meta && typeof meta === 'object' && meta.profession !== undefined) {
            villagerProfession = this.getVillagerProfessionName(meta.profession)
            villagerLevel = meta.level || 0
            break
          }
        }
      }

      // Filter by profession if specified
      if (profession) {
        const searchProf = profession.toLowerCase().replace(/_/g, '')
        const entityProf = villagerProfession.toLowerCase().replace(/_/g, '')
        if (!entityProf.includes(searchProf) && !searchProf.includes(entityProf)) {
          continue
        }
      }

      villagers.push({
        entity_id: entity.id,
        type: isWanderingTrader ? 'wandering_trader' : 'villager',
        profession: villagerProfession,
        level: villagerLevel,
        position: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        },
        distance: Math.floor(distance)
      })
    }

    // Sort by distance
    villagers.sort((a, b) => a.distance - b.distance)

    if (villagers.length === 0) {
      const profMsg = profession ? ` with profession "${profession}"` : ''
      return error(`No villagers or wandering traders found within ${max_distance} blocks${profMsg}`)
    }

    return json({
      count: villagers.length,
      villagers
    })
  }

  mcp.openVillagerTrades = async function({ entity_id, max_distance = 32 }) {
    this.requireBot()

    // Close any existing villager window
    if (this.currentVillager) {
      try {
        this.currentVillager.close()
      } catch (e) {
        // Ignore close errors
      }
      this.currentVillager = null
    }

    // Find the villager entity
    let entity
    if (entity_id !== undefined) {
      entity = this.bot.entities[entity_id]
      if (!entity) {
        return error(`No entity found with ID ${entity_id}`)
      }
    } else {
      // Find nearest villager or wandering trader
      const villagerTypes = ['villager', 'wandering_trader']
      entity = this.bot.nearestEntity(e => {
        if (!e || !e.position) return false
        const distance = e.position.distanceTo(this.bot.entity.position)
        if (distance > max_distance) return false
        return villagerTypes.some(t => matchesEntityType(e, t))
      })
    }

    if (!entity) {
      return error(`No villager or wandering trader found within ${max_distance} blocks`)
    }

    // Verify it's a villager type
    const isVillager = matchesEntityType(entity, 'villager')
    const isWanderingTrader = matchesEntityType(entity, 'wandering_trader')
    if (!isVillager && !isWanderingTrader) {
      return error(`Entity ${entity_id} is not a villager or wandering trader (type: ${entity.name || entity.mobType})`)
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

    // Open the villager trading window
    try {
      const villager = await this.bot.openVillager(entity)

      // Wait for trades to load
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for trades to load'))
        }, 5000)

        if (villager.trades && villager.trades.length > 0) {
          clearTimeout(timeout)
          resolve()
        } else {
          villager.once('ready', () => {
            clearTimeout(timeout)
            resolve()
          })
        }
      })

      this.currentVillager = villager

      // Format trades for output
      const trades = villager.trades.map((trade, index) => {
        const result = {
          index,
          input1: {
            name: trade.inputItem1?.name || 'unknown',
            count: trade.inputItem1?.count || 0
          },
          output: {
            name: trade.outputItem?.name || 'unknown',
            count: trade.outputItem?.count || 0
          },
          disabled: trade.tradeDisabled || false,
          uses: trade.nbTradeUses || 0,
          max_uses: trade.maximumNbTradeUses || 0
        }

        if (trade.inputItem2 && trade.inputItem2.count > 0) {
          result.input2 = {
            name: trade.inputItem2.name,
            count: trade.inputItem2.count
          }
        }

        return result
      })

      const entityType = isWanderingTrader ? 'wandering_trader' : 'villager'

      return json({
        success: true,
        entity_type: entityType,
        entity_id: entity.id,
        trade_count: trades.length,
        trades,
        position: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        }
      })
    } catch (err) {
      this.currentVillager = null
      return error(`Failed to open trades: ${err.message}`)
    }
  }

  mcp.tradeWithVillager = async function({ trade_index, times = 1 }) {
    this.requireBot()

    if (!this.currentVillager) {
      return error('No villager trade window is open. Use open_villager_trades first.')
    }

    if (!this.currentVillager.trades || this.currentVillager.trades.length === 0) {
      return error('No trades available')
    }

    if (trade_index < 0 || trade_index >= this.currentVillager.trades.length) {
      return error(`Invalid trade index ${trade_index}. Valid range: 0-${this.currentVillager.trades.length - 1}`)
    }

    const trade = this.currentVillager.trades[trade_index]

    if (trade.tradeDisabled) {
      return error(`Trade ${trade_index} is currently disabled (out of stock)`)
    }

    // Check if we have the required items
    const input1 = trade.inputItem1
    const input2 = trade.inputItem2

    const inventory = this.bot.inventory.items()

    const countItem = (itemName) => {
      return inventory
        .filter(i => i.name === itemName)
        .reduce((sum, i) => sum + i.count, 0)
    }

    const have1 = countItem(input1.name)
    const need1 = input1.count * times

    if (have1 < need1) {
      return error(`Not enough ${input1.name}: have ${have1}, need ${need1} for ${times} trade(s)`)
    }

    if (input2 && input2.count > 0) {
      const have2 = countItem(input2.name)
      const need2 = input2.count * times
      if (have2 < need2) {
        return error(`Not enough ${input2.name}: have ${have2}, need ${need2} for ${times} trade(s)`)
      }
    }

    // Execute the trade
    try {
      await this.currentVillager.trade(trade_index, times)

      const output = trade.outputItem

      return json({
        success: true,
        trade_index,
        times_traded: times,
        gave: [
          { name: input1.name, count: input1.count * times },
          ...(input2 && input2.count > 0 ? [{ name: input2.name, count: input2.count * times }] : [])
        ],
        received: {
          name: output.name,
          count: output.count * times
        }
      })
    } catch (err) {
      return error(`Trade failed: ${err.message}`)
    }
  }

  mcp.closeVillagerTrades = function() {
    this.requireBot()

    if (!this.currentVillager) {
      return text('No villager trade window is currently open')
    }

    try {
      this.currentVillager.close()
    } catch (e) {
      // Ignore close errors
    }

    this.currentVillager = null
    return json({ success: true, message: 'Trade window closed' })
  }
}
