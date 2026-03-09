/**
 * Lenient window_items parser
 *
 * When mineflayer's normal packet deserializer fails on window_items packets
 * (e.g. shulker boxes with complex item component data in MC 1.21+), this
 * module provides a fallback that extracts whatever slot data it can from the
 * raw packet bytes.
 *
 * Usage:
 *   installRawPacketInterceptor(bot, mcData)  — call after bot emits 'login'
 *   Then check bot._rawWindowItems when openContainer times out.
 */

// ── varint helpers ──────────────────────────────────────────────────────────

function readVarInt (buf, offset) {
  let value = 0
  let size = 0
  let byte
  do {
    if (offset + size >= buf.length) return null
    byte = buf[offset + size]
    value |= (byte & 0x7f) << (size * 7)
    size++
    if (size > 5) return null
  } while (byte & 0x80)
  if (value > 0x7fffffff) value -= 0x100000000
  return { value, size }
}

// ── lenient packet parser ───────────────────────────────────────────────────

/**
 * Parse a raw window_items packet buffer, extracting as much slot data as
 * possible.  Uses the protocol's Slot parser per-slot with try/catch.  Slots
 * that fail are recorded with just itemId and count (components dropped).
 * All slots after an unrecoverable failure are marked { unparsed: true }.
 *
 * @param {object} bot       mineflayer bot
 * @param {Buffer} rawBuf    complete decompressed packet bytes (incl. packet ID)
 * @returns {{ windowId, stateId, items, carriedItem } | null}
 */
export function parseWindowItemsRaw (bot, rawBuf) {
  const proto = bot._client.deserializer.proto
  let offset = 0

  // Packet ID varint
  const pktId = readVarInt(rawBuf, offset)
  if (!pktId) return null
  offset += pktId.size

  // windowId (varint — works for both u8 and varint ContainerID)
  const windowId = readVarInt(rawBuf, offset)
  if (!windowId) return null
  offset += windowId.size

  // stateId
  const stateId = readVarInt(rawBuf, offset)
  if (!stateId) return null
  offset += stateId.size

  // item count
  const count = readVarInt(rawBuf, offset)
  if (!count || count.value < 0 || count.value > 200) return null
  offset += count.size

  const items = []
  let parseFailed = false

  for (let i = 0; i < count.value; i++) {
    if (parseFailed || offset >= rawBuf.length) {
      items.push({ slot: i, unparsed: true })
      continue
    }

    // Try the full Slot parser first
    try {
      const result = proto.read(rawBuf, offset, 'Slot', {})
      items.push({ slot: i, data: result.value })
      offset += result.size
      continue
    } catch (_) {
      // Full parse failed — try minimal extraction
    }

    // Minimal: read itemCount + itemId varints
    const itemCount = readVarInt(rawBuf, offset)
    if (!itemCount) {
      parseFailed = true
      items.push({ slot: i, unparsed: true })
      continue
    }

    if (itemCount.value === 0) {
      items.push({ slot: i, data: { itemCount: 0 } })
      offset += itemCount.size
      continue
    }

    const itemId = readVarInt(rawBuf, offset + itemCount.size)
    if (!itemId) {
      parseFailed = true
      items.push({ slot: i, unparsed: true })
      continue
    }

    // Got ID and count but can't skip the components → rest is lost
    items.push({
      slot: i,
      partial: true,
      data: { itemCount: itemCount.value, itemId: itemId.value }
    })
    parseFailed = true
  }

  // carriedItem — only parse if all items were parsed
  let carriedItem = null
  if (!parseFailed && offset < rawBuf.length) {
    try {
      const result = proto.read(rawBuf, offset, 'Slot', {})
      carriedItem = result.value
    } catch (_) {}
  }

  return {
    windowId: windowId.value,
    stateId: stateId.value,
    count: count.value,
    items,
    carriedItem
  }
}

// ── raw packet interceptor ──────────────────────────────────────────────────

/**
 * Install a raw packet interceptor that captures window_items packet bytes
 * before they reach the deserializer.  On parse failure, the raw buffer is
 * available at bot._rawWindowItems.
 *
 * @param {object} bot     mineflayer bot (must be logged in)
 * @param {object} mcData  minecraft-data for the bot's version
 */
export function installRawPacketInterceptor (bot, mcData) {
  // Find window_items packet ID for this version
  const mappings = mcData.protocol?.play?.toClient?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings
  if (!mappings) {
    console.error('[lenient-parser] Could not find packet mappings')
    return
  }

  let windowItemsId = null
  for (const [id, name] of Object.entries(mappings)) {
    if (name === 'window_items') {
      windowItemsId = parseInt(id, 16)
      break
    }
  }
  if (windowItemsId === null) {
    console.error('[lenient-parser] Could not find window_items packet ID')
    return
  }

  // Listen on the stream feeding the deserializer.
  // After compression is enabled: splitter → decompressor → deserializer
  // Before compression: splitter → deserializer
  // By login time, compression is always enabled for MC 1.7+.
  const source = bot._client.decompressor || bot._client.splitter
  if (!source) {
    console.error('[lenient-parser] No decompressor or splitter stream found')
    return
  }

  bot._rawWindowItems = null

  source.on('data', (chunk) => {
    const pktId = readVarInt(chunk, 0)
    if (pktId && pktId.value === windowItemsId) {
      // Read windowId to filter — only capture container windows (id > 0).
      // Window 0 is the player inventory and is refreshed frequently.
      const winId = readVarInt(chunk, pktId.size)
      if (winId && winId.value > 0) {
        bot._rawWindowItems = Buffer.from(chunk)
      }
    }
  })

  // Clear when normal parsing succeeds
  bot._client.on('window_items', () => {
    bot._rawWindowItems = null
  })

  console.error(`[lenient-parser] Interceptor installed (window_items = 0x${windowItemsId.toString(16)})`)
}
