/**
 * Container tools - open_container, get_container_contents, transfer_items, close_container
 */

import { text, json, error } from '../utils/helpers.js'
import { checkClaimStatus } from '../utils/claims.js'
import { parseWindowItemsRaw } from '../utils/lenient-parser.js'
import PrismarineItem from 'prismarine-item'

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

    // Ensure coordinates are integers - floats can cause blockAt to return invalid objects
    const bx = Math.floor(x)
    const by = Math.floor(y)
    const bz = Math.floor(z)

    const block = this.bot.blockAt(new Vec3(bx, by, bz))
    if (!block) {
      return error(`No block found at ${bx}, ${by}, ${bz}`)
    }

    // Verify the block object is valid for mineflayer's openContainer
    if (!block.type && block.type !== 0) {
      return error(`Invalid block object at ${bx}, ${by}, ${bz} - block.type is undefined. Block name: ${block.name}`)
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
      return error(`Block "${block.name}" at ${bx}, ${by}, ${bz} is not a container`)
    }

    // Track whether the server opened the window (open_window packet received)
    // vs never responding at all (claim denial). This distinguishes:
    //   1. Claim denial: server ignores the activate_block, no packets sent
    //   2. Parser failure: server sends open_window + window_items, but
    //      prismarine-item can't deserialize items (e.g. shulker boxes with
    //      nested item components in MC 1.21+), so mineflayer's windowOpen
    //      event never fires even though the window is open server-side.
    let serverOpenedWindow = false
    let openWindowPacket = null
    const onOpenWindow = (packet) => {
      serverOpenedWindow = true
      openWindowPacket = packet
    }
    this.bot._client.on('open_window', onOpenWindow)

    try {

      const openTimeout = 5000
      const openPromise = this.bot.openContainer(block)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), openTimeout)
      )

      let window
      try {
        window = await Promise.race([openPromise, timeoutPromise])
      } finally {
        this.bot._client.removeListener('open_window', onOpenWindow)
      }

      return this._formatContainerResult(window, block, bx, by, bz)
    } catch (err) {
      if (err.message === 'TIMEOUT' || err.message.includes('timeout')) {
        if (serverOpenedWindow && this.bot._rawWindowItems) {
          // Server opened the window but the normal parser couldn't handle
          // the window_items packet.  Try lenient parsing of the raw bytes.
          return this._handleLenientOpen(openWindowPacket, block, bx, by, bz)
        }

        if (serverOpenedWindow) {
          // Server opened but no raw buffer captured — close to avoid desync
          try { this.bot._client.write('close_window', { windowId: 0 }) } catch (_) {}
          return json({
            error: 'container_parse_failure',
            message: `Container at ${bx}, ${by}, ${bz} opened server-side but item data could not be parsed. This is a known issue with containers holding shulker boxes or items with complex NBT data (MC 1.21+ protocol). The raw packet interceptor did not capture the data.`,
            block_name: block.name,
            position: { x: bx, y: by, z: bz }
          })
        }

        // Server never responded — likely a claim denial
        const claimInfo = await checkClaimStatus(this.bot)
        return json({
          error: 'container_access_denied',
          message: `Cannot open container at ${bx}, ${by}, ${bz} - likely protected by a claim`,
          block_name: block.name,
          position: { x: bx, y: by, z: bz },
          claim_info: claimInfo
        })
      }

      return error(`Failed to open container: ${err.message}`)
    }
  }

  // Format a successfully opened container window into the MCP response
  mcp._formatContainerResult = function(window, block, bx, by, bz) {
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
      block_name: block.name,
      position: { x: bx, y: by, z: bz },
      window_type: window.type,
      slot_layout: layout.slots,
      container_slot_count: layout.containerSlotCount || window.containerItems().length,
      container_items: containerItems,
      inventory: inventoryItems
    })
  }

  // Handle a container open that timed out due to a window_items parse failure.
  // Uses the raw packet bytes captured by the lenient parser interceptor.
  //
  // Strategy: mineflayer's open_window handler already created a Window object
  // at bot.currentWindow, but its slots are empty and it lacks deposit/withdraw
  // methods (because the window_items parse failure prevented extendWindow from
  // running). We populate the window from our lenient-parsed data, then trigger
  // mineflayer's internal extendWindow via the setWindowItems event. This gives
  // us a fully functional container window for items we could parse.
  mcp._handleLenientOpen = function(openWindowPacket, block, bx, by, bz) {
    const rawBuf = this.bot._rawWindowItems
    this.bot._rawWindowItems = null

    const parsed = parseWindowItemsRaw(this.bot, rawBuf)
    if (!parsed) {
      // Clean up the window mineflayer created from the open_window packet
      if (this.bot.currentWindow) {
        try { this.bot._client.write('close_window', { windowId: this.bot.currentWindow.id }) } catch (_) {}
        this.bot.currentWindow = null
      }
      return json({
        error: 'container_parse_failure',
        message: `Container at ${bx}, ${by}, ${bz} opened but raw packet parsing also failed.`,
        block_name: block.name,
        position: { x: bx, y: by, z: bz }
      })
    }

    // Check if mineflayer created a window from the open_window packet.
    // If it exists and matches, we can build a functional window.
    // If not (e.g. server transfer cleared it), fall back to read-only.
    const window = this.bot.currentWindow
    if (!window || window.id !== parsed.windowId) {
      return this._readOnlyLenientResult(parsed, openWindowPacket, block, bx, by, bz)
    }

    // Create Item class for this MC version
    const Item = PrismarineItem(this.bot.version)

    // Track partial/unparsed items — these are reported but NOT placed in the
    // window (they can't be safely transferred because we lack full component data)
    const partialItems = []
    const unparsedSlotList = []

    // Populate container slots from parsed data
    for (const entry of parsed.items) {
      // Skip inventory portion — we'll populate that from bot.inventory
      if (entry.slot >= window.inventoryStart) continue

      if (entry.unparsed) {
        unparsedSlotList.push(entry.slot)
        continue
      }

      const d = entry.data
      if (!d || d.itemCount === 0) continue

      if (!entry.partial) {
        // Full proto.read parse succeeded — create Item from protocol Slot data
        try {
          const item = Item.fromNotch(d)
          if (item) window.updateSlot(entry.slot, item)
        } catch (e) {
          // fromNotch failed despite successful proto.read — treat as partial
          const itemInfo = d.itemId != null ? this.mcData.items[d.itemId] : null
          partialItems.push({
            slot: entry.slot,
            name: itemInfo?.name || 'unknown',
            count: d.itemCount
          })
        }
      } else {
        // Partial parse — only itemId + count extracted, no component data.
        // Don't populate in window (can't safely serialize for window_click).
        const itemInfo = d.itemId != null ? this.mcData.items[d.itemId] : null
        partialItems.push({
          slot: entry.slot,
          name: itemInfo?.name || 'unknown',
          count: d.itemCount
        })
      }
    }

    // Populate the player inventory portion of the window from bot.inventory.
    // After a lenient parse, all slots after the first unparseable one are lost,
    // including the inventory portion at the end of the packet. We reconstruct
    // it from mineflayer's separately-maintained inventory state.
    for (let i = window.inventoryStart; i < window.inventoryEnd; i++) {
      const invIdx = i - window.inventoryStart + this.bot.inventory.inventoryStart
      const original = this.bot.inventory.slots[invIdx]
      if (original) {
        // Clone to avoid mutating bot.inventory's item.slot property
        const clone = new Item(original.type, original.count, original.metadata, original.nbt)
        window.updateSlot(i, clone)
      }
    }

    // Trigger mineflayer's internal extendWindow() by emitting the event that
    // prepareWindow registered a once-listener for. This adds close(),
    // withdraw(), and deposit() methods to the window, making it fully
    // functional for transfer operations.
    this.bot.emit(`setWindowItems:${parsed.windowId}`)

    // Update the stateId closure in mineflayer's inventory plugin so that
    // window_click packets include the correct stateId (required for MC 1.17+).
    // windowId: -2 ensures the set_slot handler exits early (no matching window)
    // while the stateId listener still fires and captures our value.
    this.bot._client.emit('set_slot', {
      windowId: -2,
      stateId: parsed.stateId,
      slot: 0,
      item: { present: false }
    })

    // Format result — window stays open, transfers work for fully-parsed items
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

    const result = {
      container_type: layout.type,
      block_name: block.name,
      position: { x: bx, y: by, z: bz },
      window_type: window.type,
      slot_layout: layout.slots,
      container_slot_count: layout.containerSlotCount || window.inventoryStart,
      container_items: containerItems,
      inventory: inventoryItems,
      lenient_parse: true
    }

    const totalIssues = partialItems.length + unparsedSlotList.length
    if (partialItems.length > 0) result.partial_items = partialItems
    if (unparsedSlotList.length > 0) result.unparsed_slots = unparsedSlotList

    if (totalIssues > 0) {
      result.note = `${totalIssues} slot(s) contain items with complex component data (likely shulker boxes). ` +
        'These items are listed in partial_items but cannot be transferred. ' +
        'All other items in the container can be transferred normally using transfer_items.'
    } else {
      result.note = 'Container was opened using the raw packet fallback. All slots parsed successfully. ' +
        'The container is open and items can be transferred normally using transfer_items.'
    }

    return json(result)
  }

  // Fallback: read-only result when bot.currentWindow doesn't match the parsed
  // windowId (e.g. server transfer cleared the window between open and timeout)
  mcp._readOnlyLenientResult = function(parsed, openWindowPacket, block, bx, by, bz) {
    // Close server-side window
    try { this.bot._client.write('close_window', { windowId: parsed.windowId }) } catch (_) {}
    if (this.bot.currentWindow) this.bot.currentWindow = null

    const containerItems = []
    const unparsedSlots = []

    for (const item of parsed.items) {
      if (item.unparsed) { unparsedSlots.push(item.slot); continue }
      const d = item.data
      if (!d || d.itemCount === 0) continue
      const itemId = d.itemId != null ? d.itemId : null
      const itemInfo = itemId != null ? this.mcData.items[itemId] : null
      containerItems.push({
        slot: item.slot,
        name: itemInfo?.name || 'unknown',
        count: d.itemCount,
        partial: item.partial || false
      })
    }

    const inventoryItems = this.bot.inventory.items().map(item => ({
      slot: item.slot, name: item.name, count: item.count
    }))

    const windowType = openWindowPacket?.inventoryType || 'minecraft:generic_9x3'
    const layout = this.getContainerSlotLayout(windowType)

    return json({
      container_type: layout.type,
      block_name: block.name,
      position: { x: bx, y: by, z: bz },
      window_type: windowType,
      slot_layout: layout.slots,
      container_slot_count: layout.containerSlotCount || parsed.count,
      container_items: containerItems,
      inventory: inventoryItems,
      lenient_parse: true,
      read_only: true,
      unparsed_slots: unparsedSlots.length > 0 ? unparsedSlots : undefined,
      note: 'Container was parsed in read-only mode (window state could not be reconstructed). ' +
        'The container is now closed. Items cannot be transferred.'
    })
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
