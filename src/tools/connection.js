/**
 * Connection tools - connect, disconnect, get_connection_status
 */

import { text, json, logBotMessage } from '../utils/helpers.js'

export const tools = [
  {
    name: 'connect',
    description: 'Connect bot to a Minecraft server. For online-mode servers, use auth="microsoft" and username as your Microsoft email.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Server hostname', default: 'localhost' },
        port: { type: 'number', description: 'Server port', default: 25565 },
        username: { type: 'string', description: 'Bot username (or Microsoft email for auth=microsoft)' },
        version: { type: 'string', description: 'Minecraft version (e.g. 1.20.1)' },
        auth: { type: 'string', description: 'Auth type: "microsoft" for online-mode servers, omit for offline', enum: ['microsoft'] }
      },
      required: ['username']
    }
  },
  {
    name: 'disconnect',
    description: 'Disconnect bot from server (stops auto-reconnect)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_connection_status',
    description: 'Get current connection state. Returns: disconnected, connecting, connected, or reconnecting. Use this to check if the bot is connected before other operations.',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['connect'] = async (args) => mcp.connect(args)
  mcp.handlers['disconnect'] = () => mcp.disconnect()
  mcp.handlers['get_connection_status'] = () => mcp.getConnectionStatus()
}

export function registerMethods(mcp, mineflayer, minecraftData, pathfinder) {
  mcp.getConnectionStatus = function() {
    return json({
      state: this.connectionState,
      reconnectAttempt: this.connectionState === 'reconnecting' ? this.reconnectAttempt : null,
      maxReconnectAttempts: this.maxReconnectAttempts,
      lastDisconnectReason: this.lastDisconnectReason,
      botUsername: this.bot?.username || null
    })
  }

  mcp.connect = async function({ host = 'localhost', port = 25565, username, version, auth }, isReconnect = false) {
    // Store credentials for auto-reconnect
    if (!isReconnect) {
      this.connectArgs = { host, port, username, version, auth }
    }

    // If already connecting/reconnecting, don't start another connection
    if (this.connectionState === 'connecting' || this.connectionState === 'reconnecting') {
      return text(`Already ${this.connectionState}. Please wait.`)
    }

    // Set state
    this.connectionState = isReconnect ? 'reconnecting' : 'connecting'
    console.error(`Connection state: ${this.connectionState}`)

    // Clean up existing bot
    if (this.bot) {
      try {
        this.bot.quit()
      } catch (e) {
        console.error('Error quitting bot:', e.message)
      }
      this.bot = null
      await new Promise(r => setTimeout(r, 500))
    }

    return new Promise((resolve, reject) => {
      const opts = { host, port, username }
      if (version) opts.version = version

      let msaCodeInfo = null
      if (auth === 'microsoft') {
        opts.auth = 'microsoft'
        opts.authFlow = 'sisu'
        opts.onMsaCode = (data) => {
          msaCodeInfo = data
          console.error(`\nMicrosoft Login Required!\nGo to: ${data.verification_uri}\nEnter code: ${data.user_code}\n`)
        }
      }

      let resolved = false
      const finish = (success, result) => {
        if (resolved) return
        resolved = true
        if (success) {
          resolve(result)
        } else {
          this.connectionState = 'disconnected'
          reject(result)
        }
      }

      try {
        console.error(`Creating bot for ${username}@${host}:${port}...`)
        this.bot = mineflayer.createBot(opts)
        this.bot.loadPlugin(pathfinder)
        console.error('Bot object created, waiting for login/spawn...')
      } catch (err) {
        console.error('Failed to create bot:', err.message)
        finish(false, new Error(`Failed to create bot: ${err.message}`))
        return
      }

      // Login event fires before spawn - good for debugging
      this.bot.once('login', () => {
        console.error(`Login successful, waiting for spawn...`)
      })

      // Success: bot spawned
      this.bot.once('spawn', () => {
        console.error('Spawn event received')
        this.mcData = minecraftData(this.bot.version)
        this.connectionState = 'connected'
        this.reconnectAttempt = 0
        this.lastDisconnectReason = null
        console.error(`Connection state: connected as ${this.bot.username}`)

        const msg = msaCodeInfo
          ? `Connected as "${this.bot.username}" to ${host}:${port} (MC ${this.bot.version})\n\nNote: Microsoft auth was used. Token cached for future connections.`
          : `Connected as "${this.bot.username}" to ${host}:${port} (MC ${this.bot.version})`
        finish(true, text(msg))
      })

      this.bot.on('chat', (user, message) => {
        this.chatLog.push({ type: 'chat', user, message, timestamp: Date.now() })
        if (this.chatLog.length > 100) this.chatLog.shift()
        // Log to file for agent to tail
        logBotMessage('chat', message, { user })
      })

      // Track sign placement to filter subsequent sign content lines
      let signPlacementTime = 0

      this.bot.on('message', (jsonMsg, position) => {
        if (position === 'system' || position === 'game_info') {
          const msgText = jsonMsg.toString()
          if (!msgText.trim()) return

          // Filter out sign placement messages (private player activity)
          // Format: "Username placed a sign @ world: x123, z456" or "Username places a sign @..."
          if (/\bplaced? a sign @/.test(msgText)) {
            signPlacementTime = Date.now()
            return  // Don't log sign placement notifications
          }

          // Filter out sign content lines (short messages with leading whitespace)
          // These come immediately after sign placement and contain the sign text
          // Format: "  Line1" "  Line2" etc (2+ leading spaces, short content)
          if (Date.now() - signPlacementTime < 500 && /^\s{2,}/.test(msgText) && msgText.length < 50) {
            return  // Don't log sign content
          }

          // Filter out private messages/whispers - bot shouldn't see these between other players
          // but if somehow received, don't forward them
          // Format: "[Player -> Player]" or "Player whispers to you:" etc
          if (/\s*->\s*/.test(msgText) || /whispers? to/i.test(msgText) || /\[.*\s*→\s*.*\]/.test(msgText)) {
            return  // Don't log private messages
          }

          // FreedomChat rewrites player chat as system messages
          // EssentialsXChat formats as "Username: message"
          // Try to parse player chat from system messages
          const chatMatch = msgText.match(/^([A-Za-z0-9_]{3,16}): (.+)$/)
          if (chatMatch && position === 'system') {
            const [, user, message] = chatMatch
            // Don't duplicate if we already got this via the chat event
            const isDuplicate = this.chatLog.some(m =>
              m.type === 'chat' && m.user === user && m.message === message &&
              Date.now() - m.timestamp < 1000
            )
            if (!isDuplicate) {
              this.chatLog.push({ type: 'chat', user, message, timestamp: Date.now() })
              if (this.chatLog.length > 100) this.chatLog.shift()
              // Log to file for agent to tail
              logBotMessage('chat', message, { user })
              return
            }
          }

          this.chatLog.push({ type: 'system', message: msgText, position, timestamp: Date.now() })
          if (this.chatLog.length > 100) this.chatLog.shift()
          // Log system messages to file for agent to tail (command responses, etc.)
          logBotMessage('system', msgText, { position })
        }
      })

      this.bot.on('error', (err) => {
        console.error('Bot error:', err.message)
        finish(false, new Error(`Connection failed: ${err.message}`))
      })

      this.bot.on('kicked', (reason) => {
        this.lastDisconnectReason = `Kicked: ${reason}`
        console.error('Kicked:', reason)
      })

      this.bot.on('end', (reason) => {
        const wasConnected = this.connectionState === 'connected'
        const disconnectReason = this.lastDisconnectReason || reason || 'Connection closed'
        console.error('Disconnected:', disconnectReason)

        this.bot = null
        this.mcData = null

        // Only set to disconnected if not already resolved (prevents race with timeout)
        if (!resolved) {
          this.connectionState = 'disconnected'
        }

        // Auto-reconnect if we were connected and have credentials
        if (wasConnected && this.connectArgs) {
          this.scheduleReconnect()
        }
      })

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!resolved && this.connectionState !== 'connected') {
          console.error('Connection timeout after 30 seconds')
          try {
            this.bot?.quit()
          } catch (e) {
            console.error('Error during timeout cleanup:', e.message)
          }
          finish(false, new Error('Connection timeout'))
        }
      }, 30000)
    })
  }

  mcp.scheduleReconnect = function() {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      console.error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`)
      this.connectionState = 'disconnected'
      return
    }

    this.reconnectAttempt++
    // Exponential backoff: 2s, 4s, 8s, 16s, ... capped at 60s
    const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempt - 1), 60000)

    console.error(`Reconnect attempt ${this.reconnectAttempt}/${this.maxReconnectAttempts} in ${delay}ms...`)
    this.connectionState = 'reconnecting'

    setTimeout(async () => {
      try {
        await this.connect(this.connectArgs, true)
        console.error('Reconnected successfully')
      } catch (err) {
        console.error(`Reconnect failed: ${err.message}`)
        // The 'end' event handler will trigger another reconnect attempt
      }
    }, delay)
  }

  mcp.disconnect = function() {
    // Clear credentials to stop auto-reconnect
    this.connectArgs = null
    this.reconnectAttempt = 0
    this.connectionState = 'disconnected'

    if (this.bot) {
      this.bot.quit()
      this.bot = null
      this.mcData = null
      return text('Disconnected. Auto-reconnect disabled.')
    }
    return text('Not connected')
  }
}
