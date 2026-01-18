/**
 * Economy tools - list_all_shops, search_shops, create_chest_shop (QuickShop integration)
 */

import { text, json, error } from '../utils/helpers.js'
import { checkClaimStatus } from '../utils/claims.js'
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const tools = [
  {
    name: 'list_all_shops',
    description: 'List all player shops on the server. Returns shop owners, items for sale, prices, and locations. Use this to understand market opportunities and what\'s available for purchase.',
    inputSchema: {
      type: 'object',
      properties: {
        shop_type: {
          type: 'string',
          enum: ['all', 'selling', 'buying'],
          description: 'Filter by shop type: "selling" (players buy from shop), "buying" (players sell to shop), or "all"',
          default: 'all'
        }
      }
    }
  },
  {
    name: 'search_shops',
    description: 'Search for shops selling or buying a specific item. Returns matching shops with owner names, prices, and locations. Use when a player asks "does anyone sell X" or "where can I buy X".',
    inputSchema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Item to search for (e.g. diamond, oak_log, iron_ingot). Partial matches are supported.' }
      },
      required: ['item_name']
    }
  },
  {
    name: 'create_chest_shop',
    description: 'Create a QuickShop chest shop. Places a chest (if needed), stocks it with items, and creates the shop. Requires QuickShop-Hikari plugin.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate for the shop chest' },
        y: { type: 'number', description: 'Y coordinate for the shop chest' },
        z: { type: 'number', description: 'Z coordinate for the shop chest' },
        item_name: { type: 'string', description: 'Name of the item to sell (e.g. diamond, iron_ingot, oak_log)' },
        price: { type: 'number', description: 'Price per item in server currency' },
        stock_count: { type: 'number', description: 'Number of items to stock from inventory (0 to not stock any)', default: 0 },
        mode: { type: 'string', enum: ['sell', 'buy'], description: 'Shop mode: "sell" = players buy from shop, "buy" = players sell to shop', default: 'sell' },
        place_chest: { type: 'boolean', description: 'If true, place a new chest. If false, use existing chest at coordinates.', default: true }
      },
      required: ['x', 'y', 'z', 'item_name', 'price']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['list_all_shops'] = async (args) => mcp.listAllShops(args)
  mcp.handlers['search_shops'] = async (args) => mcp.searchShops(args)
  mcp.handlers['create_chest_shop'] = async (args) => mcp.createChestShop(args)
}

export function registerMethods(mcp, Vec3) {
  // QuickShop database paths (requires MC_SERVER_ROOT env var)
  mcp.getQuickShopPaths = function() {
    const serverRoot = process.env.MC_SERVER_ROOT
    if (!serverRoot) {
      return null
    }
    return {
      dbPath: path.join(serverRoot, 'plugins/QuickShop-Hikari/shops.mv.db'),
      h2Jar: path.join(serverRoot, 'plugins/QuickShop-Hikari/lib/com/h2database/h2/2.1.214/h2-2.1.214.jar'),
      tempDb: '/tmp/quickshop_readonly'
    }
  }

  // Execute SQL query on QuickShop H2 database
  mcp.queryQuickShopDb = async function(sql) {
    const paths = this.getQuickShopPaths()

    if (!paths) {
      throw new Error('QuickShop features require MC_SERVER_ROOT environment variable pointing to your Minecraft server directory')
    }

    // Check if database exists
    if (!fs.existsSync(paths.dbPath)) {
      throw new Error('QuickShop database not found at ' + paths.dbPath)
    }

    // Check if H2 jar exists
    if (!fs.existsSync(paths.h2Jar)) {
      throw new Error('H2 database driver not found')
    }

    // Copy database to temp location (to avoid locking issues)
    const tempDbFile = `${paths.tempDb}.mv.db`
    fs.copyFileSync(paths.dbPath, tempDbFile)

    try {
      // Execute query using H2 shell
      const cmd = `java -cp "${paths.h2Jar}" org.h2.tools.Shell -url "jdbc:h2:${paths.tempDb}" -user "" -password "" -sql "${sql.replace(/"/g, '\\"')}"`
      const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 })
      return stdout
    } finally {
      // Clean up temp database files
      try {
        if (fs.existsSync(tempDbFile)) fs.unlinkSync(tempDbFile)
        if (fs.existsSync(`${paths.tempDb}.trace.db`)) fs.unlinkSync(`${paths.tempDb}.trace.db`)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  // Parse H2 shell output into structured data
  mcp.parseH2Output = function(output) {
    const lines = output.trim().split('\n')
    if (lines.length < 2) return []

    // First line is headers (pipe-separated)
    const headers = lines[0].split('|').map(h => h.trim().toLowerCase())

    // Collect all content after headers, excluding metadata lines
    const dataLines = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('(') && (line.includes('row') || line.includes('truncated'))) continue
      dataLines.push(line)
    }

    // Join all data lines and split by row boundaries
    const fullData = dataLines.join('\n')

    // Split into rows by looking for lines starting with a number followed by spaces and pipe
    const rowPattern = /^(\d+)\s*\|/gm
    const matches = [...fullData.matchAll(rowPattern)]

    const results = []
    for (let i = 0; i < matches.length; i++) {
      const startIdx = matches[i].index
      const endIdx = i < matches.length - 1 ? matches[i + 1].index : fullData.length
      const rowText = fullData.substring(startIdx, endIdx).trim()

      // Parse this row's pipe-separated values
      const values = []
      let currentValue = ''
      let pipeCount = 0

      const parts = rowText.split('|')
      for (let j = 0; j < parts.length; j++) {
        if (pipeCount < headers.length - 1) {
          values.push(parts[j].trim())
          pipeCount++
        } else {
          currentValue += (currentValue ? '|' : '') + parts[j]
        }
      }
      if (currentValue) values.push(currentValue.trim())

      if (values.length >= headers.length) {
        const row = {}
        headers.forEach((h, idx) => {
          row[h] = values[idx] || ''
        })
        results.push(row)
      }
    }

    return results
  }

  // Extract item name from QuickShop YAML item data
  mcp.extractItemName = function(itemYaml) {
    const match = itemYaml.match(/id:\s*minecraft:(\w+)/)
    return match ? match[1] : 'unknown'
  }

  // Parse QuickShop location string (format: "2;X;Y;Z;world")
  mcp.parseShopLocation = function(locString) {
    const parts = locString.split(';')
    if (parts.length >= 5) {
      return {
        x: parseInt(parts[1]),
        y: parseInt(parts[2]),
        z: parseInt(parts[3]),
        world: parts[4]
      }
    }
    return null
  }

  mcp.listAllShops = async function({ shop_type = 'all' } = {}) {
    try {
      let sql = `SELECT d.ID, p.CACHEDNAME as OWNER_NAME, d.ITEM, d.TYPE, d.PRICE, d.UNLIMITED, d.INV_SYMBOL_LINK as LOCATION FROM DATA d LEFT JOIN PLAYERS p ON d.OWNER = p.UUID`

      if (shop_type === 'selling') {
        sql += ` WHERE d.TYPE = 0`
      } else if (shop_type === 'buying') {
        sql += ` WHERE d.TYPE = 1`
      }

      const output = await this.queryQuickShopDb(sql)
      const rows = this.parseH2Output(output)

      if (rows.length === 0) {
        return json({
          total_shops: 0,
          shops: [],
          message: 'No shops found on the server'
        })
      }

      const shops = rows.map(row => {
        const location = this.parseShopLocation(row.location)
        return {
          id: parseInt(row.id),
          owner: row.owner_name || 'Unknown',
          item: this.extractItemName(row.item),
          type: row.type === '0' ? 'selling' : 'buying',
          price: parseFloat(row.price),
          unlimited_stock: row.unlimited === 'TRUE',
          location
        }
      })

      // Group by item for market analysis
      const itemSummary = {}
      for (const shop of shops) {
        if (!itemSummary[shop.item]) {
          itemSummary[shop.item] = { selling: [], buying: [] }
        }
        if (shop.type === 'selling') {
          itemSummary[shop.item].selling.push({ owner: shop.owner, price: shop.price })
        } else {
          itemSummary[shop.item].buying.push({ owner: shop.owner, price: shop.price })
        }
      }

      return json({
        total_shops: shops.length,
        shops,
        market_summary: itemSummary
      })
    } catch (err) {
      return error(`Failed to list shops: ${err.message}`)
    }
  }

  mcp.searchShops = async function({ item_name }) {
    try {
      if (!item_name || item_name.trim() === '') {
        return error('Item name is required')
      }

      const searchTerm = item_name.toLowerCase().replace(/ /g, '_')

      const sql = `SELECT d.ID, p.CACHEDNAME as OWNER_NAME, d.ITEM, d.TYPE, d.PRICE, d.UNLIMITED, d.INV_SYMBOL_LINK as LOCATION FROM DATA d LEFT JOIN PLAYERS p ON d.OWNER = p.UUID`
      const output = await this.queryQuickShopDb(sql)
      const rows = this.parseH2Output(output)

      const matchingShops = rows.filter(row => {
        const itemName = this.extractItemName(row.item)
        return itemName.includes(searchTerm)
      }).map(row => {
        const location = this.parseShopLocation(row.location)
        return {
          id: parseInt(row.id),
          owner: row.owner_name || 'Unknown',
          item: this.extractItemName(row.item),
          type: row.type === '0' ? 'selling' : 'buying',
          price: parseFloat(row.price),
          unlimited_stock: row.unlimited === 'TRUE',
          location
        }
      })

      if (matchingShops.length === 0) {
        return json({
          search_term: item_name,
          found: 0,
          message: `No shops found selling or buying "${item_name}"`,
          shops: []
        })
      }

      const selling = matchingShops.filter(s => s.type === 'selling')
        .sort((a, b) => a.price - b.price)
      const buying = matchingShops.filter(s => s.type === 'buying')
        .sort((a, b) => b.price - a.price)

      return json({
        search_term: item_name,
        found: matchingShops.length,
        selling: selling.length > 0 ? {
          count: selling.length,
          cheapest_price: selling[0].price,
          shops: selling
        } : null,
        buying: buying.length > 0 ? {
          count: buying.length,
          best_offer: buying[0].price,
          shops: buying
        } : null
      })
    } catch (err) {
      return error(`Failed to search shops: ${err.message}`)
    }
  }

  mcp.createChestShop = async function({ x, y, z, item_name, price, stock_count = 0, mode = 'sell', place_chest = true }) {
    this.requireBot()

    const targetPos = new Vec3(x, y, z)
    const steps = []

    // Step 1: Check if we need to place a chest
    let chestBlock = this.bot.blockAt(targetPos)

    if (place_chest) {
      if (chestBlock && chestBlock.boundingBox === 'block') {
        if (!chestBlock.name.includes('chest') && chestBlock.name !== 'barrel') {
          return error(`Position ${x}, ${y}, ${z} is occupied by ${chestBlock.name}. Set place_chest=false to use existing container.`)
        }
        steps.push({ step: 'chest_exists', message: `Using existing ${chestBlock.name} at position` })
      } else {
        const chestItem = this.bot.inventory.items().find(i =>
          i.name === 'chest' || i.name === 'trapped_chest' || i.name === 'barrel'
        )
        if (!chestItem) {
          return error('No chest, trapped_chest, or barrel found in inventory to place')
        }

        try {
          await this.bot.equip(chestItem, 'hand')
        } catch (err) {
          return error(`Failed to equip chest: ${err.message}`)
        }

        // Find reference block to place against
        const faceMap = {
          top:    { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
          bottom: { offset: new Vec3(0, 1, 0),  face: new Vec3(0, -1, 0) },
          north:  { offset: new Vec3(0, 0, 1),  face: new Vec3(0, 0, -1) },
          south:  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
          east:   { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
          west:   { offset: new Vec3(1, 0, 0),  face: new Vec3(-1, 0, 0) }
        }

        let referenceBlock = null
        let faceVector = null
        for (const dir of ['top', 'bottom', 'north', 'south', 'east', 'west']) {
          const { offset, face } = faceMap[dir]
          const checkPos = targetPos.plus(offset)
          const block = this.bot.blockAt(checkPos)
          if (block && block.boundingBox === 'block') {
            referenceBlock = block
            faceVector = face
            break
          }
        }

        if (!referenceBlock) {
          return error(`No adjacent solid block found to place chest against at ${x}, ${y}, ${z}`)
        }

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
          await this.bot.placeBlock(referenceBlock, faceVector)
          await new Promise(resolve => setTimeout(resolve, 300))
          this.bot.removeListener('message', onMessage)
          steps.push({ step: 'chest_placed', message: `Placed ${chestItem.name}` })
        } catch (err) {
          this.bot.removeListener('message', onMessage)
          return error(`Failed to place chest: ${err.message}`)
        }

        chestBlock = this.bot.blockAt(targetPos)
        if (!chestBlock || (!chestBlock.name.includes('chest') && chestBlock.name !== 'barrel')) {
          if (denialMessages.length > 0) {
            const claimInfo = await checkClaimStatus(this.bot)
            const ownerInfo = claimInfo.owner ? ` (owned by ${claimInfo.owner})` : ''
            return error(`Cannot place chest at ${x}, ${y}, ${z} - protected by claim${ownerInfo}. Message: ${denialMessages[0]}`)
          }
          return error(`Chest placement failed - found ${chestBlock?.name || 'nothing'} at position`)
        }
      }
    } else {
      if (!chestBlock || (!chestBlock.name.includes('chest') && chestBlock.name !== 'barrel')) {
        return error(`No chest/barrel found at ${x}, ${y}, ${z}. Found: ${chestBlock?.name || 'nothing'}`)
      }
      steps.push({ step: 'using_existing', message: `Using existing ${chestBlock.name}` })
    }

    // Step 2: Find the item in inventory
    const itemToSell = this.bot.inventory.items().find(i => i.name === item_name)
    if (!itemToSell) {
      return error(`Item "${item_name}" not found in inventory. Need at least 1 to create shop.`)
    }

    // Step 3: Stock the chest if requested
    if (stock_count > 0) {
      const availableCount = this.bot.inventory.items()
        .filter(i => i.name === item_name)
        .reduce((sum, i) => sum + i.count, 0)

      if (availableCount < stock_count) {
        return error(`Not enough ${item_name} in inventory. Have ${availableCount}, need ${stock_count}`)
      }

      try {
        const window = await this.bot.openContainer(chestBlock)
        await new Promise(resolve => setTimeout(resolve, 100))

        const itemType = this.mcData.itemsByName[item_name]
        if (itemType) {
          await window.deposit(itemType.id, null, stock_count)
          steps.push({ step: 'stocked', message: `Deposited ${stock_count}x ${item_name}` })
        }

        this.bot.closeWindow(window)
        await new Promise(resolve => setTimeout(resolve, 200))
      } catch (err) {
        steps.push({ step: 'stock_warning', message: `Could not stock chest: ${err.message}` })
      }
    }

    // Step 4: Equip the item to sell
    const itemForShop = this.bot.inventory.items().find(i => i.name === item_name)
    if (!itemForShop) {
      return error(`No ${item_name} left in inventory after stocking. Need at least 1 to create shop.`)
    }

    try {
      await this.bot.equip(itemForShop, 'hand')
      await new Promise(resolve => setTimeout(resolve, 100))
      steps.push({ step: 'equipped', message: `Equipped ${item_name}` })
    } catch (err) {
      return error(`Failed to equip ${item_name}: ${err.message}`)
    }

    // Step 5: Look at the chest
    const lookTarget = new Vec3(x + 0.5, y + 0.5, z + 0.5)
    await this.bot.lookAt(lookTarget)
    await new Promise(resolve => setTimeout(resolve, 100))
    steps.push({ step: 'looked', message: `Looking at chest` })

    // Step 6: Create the shop with /qs create command
    const chatLogLengthBefore = this.chatLog.length

    this.bot.chat(`/qs create ${price}`)
    steps.push({ step: 'command_sent', message: `/qs create ${price}` })

    await new Promise(resolve => setTimeout(resolve, 500))

    // Step 7: If mode is 'buy', change to buy mode
    if (mode === 'buy') {
      this.bot.chat('/qs buy')
      steps.push({ step: 'mode_changed', message: 'Changed to buy mode' })
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    const newMessages = this.chatLog.slice(chatLogLengthBefore)
      .filter(m => m.type === 'system')
      .map(m => m.message)

    return json({
      success: true,
      shop: {
        position: { x, y, z },
        item: item_name,
        price: price,
        mode: mode,
        stocked: stock_count
      },
      steps: steps,
      server_messages: newMessages
    })
  }
}
