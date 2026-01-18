/**
 * Sign tools - place_sign, read_sign, edit_sign
 */

import { text, json, error } from '../utils/helpers.js'
import { checkClaimStatus } from '../utils/claims.js'

export const tools = [
  {
    name: 'place_sign',
    description: 'Place a sign at coordinates and write text on it. Requires a sign item in inventory. The sign is placed against an adjacent block.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate to place sign' },
        y: { type: 'number', description: 'Y coordinate to place sign' },
        z: { type: 'number', description: 'Z coordinate to place sign' },
        lines: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Array of up to 4 text lines for the sign front' },
        back_lines: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Array of up to 4 text lines for the sign back (optional)' },
        sign_type: { type: 'string', description: 'Wood type for sign (oak, spruce, birch, jungle, acacia, dark_oak, mangrove, cherry, bamboo, crimson, warped)', default: 'oak' },
        wall: { type: 'boolean', description: 'If true, place as wall sign attached to adjacent block. If false, place as standing sign on ground.', default: false }
      },
      required: ['x', 'y', 'z', 'lines']
    }
  },
  {
    name: 'read_sign',
    description: 'Read text from a sign at the specified coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate of sign' },
        y: { type: 'number', description: 'Y coordinate of sign' },
        z: { type: 'number', description: 'Z coordinate of sign' }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'edit_sign',
    description: 'Edit text on an existing sign at the specified coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate of sign' },
        y: { type: 'number', description: 'Y coordinate of sign' },
        z: { type: 'number', description: 'Z coordinate of sign' },
        lines: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Array of up to 4 text lines for the sign front' },
        back_lines: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Array of up to 4 text lines for the sign back (optional)' },
        side: { type: 'string', enum: ['front', 'back', 'both'], description: 'Which side(s) to edit: front, back, or both', default: 'front' }
      },
      required: ['x', 'y', 'z', 'lines']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['place_sign'] = async (args) => mcp.placeSign(args)
  mcp.handlers['read_sign'] = (args) => mcp.readSign(args)
  mcp.handlers['edit_sign'] = async (args) => mcp.editSign(args)
}

export function registerMethods(mcp, Vec3) {
  // Helper to extract text from sign block entity
  mcp.parseSignText = function(blockEntity) {
    if (!blockEntity) return null

    const extractLines = (textData) => {
      if (!textData || !textData.messages) return ['', '', '', '']
      return textData.messages.map(msg => {
        // Messages can be JSON text components or plain strings
        if (typeof msg === 'string') {
          try {
            const parsed = JSON.parse(msg)
            return parsed.text || parsed.toString() || ''
          } catch {
            return msg
          }
        }
        if (msg && typeof msg === 'object') {
          return msg.text || msg.toString() || ''
        }
        return ''
      })
    }

    return {
      front: extractLines(blockEntity.front_text),
      back: extractLines(blockEntity.back_text)
    }
  }

  mcp.readSign = function({ x, y, z }) {
    this.requireBot()

    const block = this.bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return error(`No block found at ${x}, ${y}, ${z}`)
    }

    if (!block.name.includes('sign')) {
      return error(`Block at ${x}, ${y}, ${z} is not a sign (found: ${block.name})`)
    }

    const blockEntity = block.blockEntity
    if (!blockEntity) {
      return json({
        position: { x, y, z },
        block_name: block.name,
        front_text: ['', '', '', ''],
        back_text: ['', '', '', ''],
        note: 'No block entity data available (sign may be empty or not yet loaded)'
      })
    }

    const signText = this.parseSignText(blockEntity)

    return json({
      position: { x, y, z },
      block_name: block.name,
      front_text: signText ? signText.front : ['', '', '', ''],
      back_text: signText ? signText.back : ['', '', '', ''],
      raw_entity: blockEntity // Include raw data for debugging
    })
  }

  mcp.editSign = async function({ x, y, z, lines = [], back_lines = [], side = 'front' }) {
    this.requireBot()

    const block = this.bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return error(`No block found at ${x}, ${y}, ${z}`)
    }

    if (!block.name.includes('sign')) {
      return error(`Block at ${x}, ${y}, ${z} is not a sign (found: ${block.name})`)
    }

    // Read current text before edit to detect if change succeeded
    let originalText = null
    if (block.blockEntity) {
      originalText = this.parseSignText(block.blockEntity)
    }

    // Prepare text lines (pad to 4 lines)
    const frontLines = [...lines]
    while (frontLines.length < 4) frontLines.push('')
    frontLines.length = 4

    const backLines = [...back_lines]
    while (backLines.length < 4) backLines.push('')
    backLines.length = 4

    // Set up listener to capture GriefPrevention denial messages
    const denialMessages = []
    const onMessage = (jsonMsg) => {
      const text = jsonMsg.toString().toLowerCase()
      if (text.includes("don't have") && text.includes("permission") ||
          text.includes("belongs to") ||
          text.includes("claimed by") ||
          text.includes("claim") && (text.includes("can't") || text.includes("cannot")) ||
          text.includes("not allowed") ||
          text.includes("that belongs to")) {
        denialMessages.push(jsonMsg.toString())
      }
    }
    this.bot.on('message', onMessage)

    // Send update_sign packet(s)
    try {
      if (side === 'front' || side === 'both') {
        this.bot._client.write('update_sign', {
          location: { x, y, z },
          isFrontText: true,
          text1: frontLines[0],
          text2: frontLines[1],
          text3: frontLines[2],
          text4: frontLines[3]
        })
      }

      if (side === 'back' || side === 'both') {
        this.bot._client.write('update_sign', {
          location: { x, y, z },
          isFrontText: false,
          text1: backLines[0],
          text2: backLines[1],
          text3: backLines[2],
          text4: backLines[3]
        })
      }
    } catch (err) {
      this.bot.removeListener('message', onMessage)
      return error(`Failed to update sign text: ${err.message}`)
    }

    // Wait for server to process and catch any denial messages
    await new Promise(resolve => setTimeout(resolve, 350))
    this.bot.removeListener('message', onMessage)

    // Read back to verify
    const verifyBlock = this.bot.blockAt(new Vec3(x, y, z))
    let verifiedText = null
    if (verifyBlock && verifyBlock.blockEntity) {
      verifiedText = this.parseSignText(verifyBlock.blockEntity)
    }

    // Check if text actually changed (server may silently reject edits in claims)
    const textUnchanged = originalText && verifiedText &&
      JSON.stringify(originalText) === JSON.stringify(verifiedText)

    if (textUnchanged && lines.length > 0) {
      if (denialMessages.length > 0) {
        const claimInfo = await checkClaimStatus(this.bot)
        const ownerInfo = claimInfo.owner ? ` (owned by ${claimInfo.owner})` : ''
        return error(`Cannot edit sign at ${x}, ${y}, ${z} - protected by claim${ownerInfo}. Message: ${denialMessages[0]}`)
      }
      // Check claim status anyway since server may not send denial message for sign edits
      const claimInfo = await checkClaimStatus(this.bot)
      if (claimInfo.claimed && claimInfo.owner) {
        return error(`Cannot edit sign at ${x}, ${y}, ${z} - sign is in a claim owned by ${claimInfo.owner} and you don't have permission`)
      }
    }

    return json({
      success: true,
      position: { x, y, z },
      side_edited: side,
      text_sent: {
        front: (side === 'front' || side === 'both') ? frontLines.filter(l => l) : undefined,
        back: (side === 'back' || side === 'both') ? backLines.filter(l => l) : undefined
      },
      text_verified: verifiedText
    })
  }

  mcp.placeSign = async function({ x, y, z, lines = [], back_lines = [], sign_type = 'oak', wall = false }) {
    this.requireBot()

    // Determine sign item name based on type and wall/standing
    const signItemName = wall ? `${sign_type}_wall_sign` : `${sign_type}_sign`
    const hangingSignName = `${sign_type}_hanging_sign`

    // Find a sign in inventory (try standing sign, wall sign, or hanging sign)
    let signItem = this.bot.inventory.items().find(i =>
      i.name === signItemName ||
      i.name === `${sign_type}_sign` ||
      i.name === `${sign_type}_wall_sign` ||
      i.name === hangingSignName ||
      i.name.endsWith('_sign')
    )

    if (!signItem) {
      return error(`No sign found in inventory. Need a sign item (e.g., ${sign_type}_sign)`)
    }

    // Equip the sign
    try {
      await this.bot.equip(signItem, 'hand')
    } catch (err) {
      return error(`Failed to equip sign: ${err.message}`)
    }

    // Find the reference block to place against
    const targetPos = new Vec3(x, y, z)
    let referenceBlock = null
    let faceVector = null

    if (wall) {
      // For wall signs, find an adjacent solid block (wall) to attach to
      const adjacentOffsets = [
        { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },  // north face
        { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },  // south face
        { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },  // west face
        { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) }   // east face
      ]

      for (const adj of adjacentOffsets) {
        const checkPos = targetPos.plus(adj.offset)
        const block = this.bot.blockAt(checkPos)
        if (block && block.boundingBox === 'block') {
          referenceBlock = block
          faceVector = adj.face
          break
        }
      }

      if (!referenceBlock) {
        return error(`No solid wall block found adjacent to ${x}, ${y}, ${z} to attach wall sign`)
      }
    } else {
      // For standing signs, place on block below
      const belowPos = targetPos.offset(0, -1, 0)
      referenceBlock = this.bot.blockAt(belowPos)
      faceVector = new Vec3(0, 1, 0) // top face

      if (!referenceBlock || referenceBlock.name === 'air') {
        return error(`No block below ${x}, ${y}, ${z} to place standing sign on`)
      }
    }

    // Set up listener to capture GriefPrevention denial messages
    const denialMessages = []
    const onMessage = (jsonMsg) => {
      const text = jsonMsg.toString().toLowerCase()
      if (text.includes("don't have") && text.includes("permission") ||
          text.includes("belongs to") ||
          text.includes("claimed by") ||
          text.includes("claim") && (text.includes("can't") || text.includes("cannot")) ||
          text.includes("not allowed") ||
          text.includes("that belongs to")) {
        denialMessages.push(jsonMsg.toString())
      }
    }
    this.bot.on('message', onMessage)

    // Place the sign block
    try {
      await this.bot.placeBlock(referenceBlock, faceVector)
    } catch (err) {
      this.bot.removeListener('message', onMessage)
      return error(`Failed to place sign: ${err.message}`)
    }

    // Wait for the sign to be placed and catch any denial messages
    await new Promise(resolve => setTimeout(resolve, 300))
    this.bot.removeListener('message', onMessage)

    // Verify the sign was placed
    const placedBlock = this.bot.blockAt(targetPos)
    if (!placedBlock || !placedBlock.name.includes('sign')) {
      if (denialMessages.length > 0) {
        const claimInfo = await checkClaimStatus(this.bot)
        const ownerInfo = claimInfo.owner ? ` (owned by ${claimInfo.owner})` : ''
        return error(`Cannot place sign at ${x}, ${y}, ${z} - protected by claim${ownerInfo}. Message: ${denialMessages[0]}`)
      }
      return error(`Sign placement failed - block at position is: ${placedBlock?.name || 'unknown'}`)
    }

    // Prepare text lines (pad to 4 lines)
    const frontLines = [...lines]
    while (frontLines.length < 4) frontLines.push('')
    frontLines.length = 4 // Truncate to 4 if more provided

    const backLines = [...back_lines]
    while (backLines.length < 4) backLines.push('')
    backLines.length = 4

    // Send update_sign packet for front text
    try {
      this.bot._client.write('update_sign', {
        location: { x, y, z },
        isFrontText: true,
        text1: frontLines[0],
        text2: frontLines[1],
        text3: frontLines[2],
        text4: frontLines[3]
      })

      // If back text was provided, update back of sign too
      if (back_lines.length > 0 && back_lines.some(l => l)) {
        this.bot._client.write('update_sign', {
          location: { x, y, z },
          isFrontText: false,
          text1: backLines[0],
          text2: backLines[1],
          text3: backLines[2],
          text4: backLines[3]
        })
      }
    } catch (err) {
      return error(`Sign placed but failed to set text: ${err.message}`)
    }

    // Wait a bit for the server to process the sign update
    await new Promise(resolve => setTimeout(resolve, 250))

    // Read back the sign to verify text was set
    const verifyBlock = this.bot.blockAt(targetPos)
    let verifiedText = null
    if (verifyBlock && verifyBlock.blockEntity) {
      verifiedText = this.parseSignText(verifyBlock.blockEntity)
    }

    const result = {
      success: true,
      position: { x, y, z },
      sign_type: signItem.name,
      text_sent: {
        front: frontLines.filter(l => l),
        back: backLines.filter(l => l).length > 0 ? backLines.filter(l => l) : undefined
      },
      text_verified: verifiedText
    }

    return json(result)
  }
}
