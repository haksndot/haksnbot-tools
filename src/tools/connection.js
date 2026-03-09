/**
 * Connection tools - get_connection_status only (connect/disconnect are infrastructure)
 */

import path from 'path'
import { text, json, logBotMessage } from '../utils/helpers.js'
import { installRawPacketInterceptor } from '../utils/lenient-parser.js'

export const tools = [
  {
    name: 'get_connection_status',
    description: 'Get current connection state. Returns: disconnected, connecting, connected, or reconnecting. Use this to check if the bot is connected before other operations.',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['get_connection_status'] = () => mcp.getConnectionStatus()
}

export function registerMethods(mcp, mineflayer, minecraftData, pathfinder) {
  mcp.getConnectionStatus = function() {
    return json({
      state: this.connectionState,
      reconnectAttempt: this.connectionState === 'reconnecting' ? this.reconnectAttempt : null,
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
    // But allow reconnect attempts through (isReconnect=true) — scheduleReconnect
    // sets state to 'reconnecting' before calling connect(), so this guard would
    // otherwise block every reconnection attempt.
    if (!isReconnect && (this.connectionState === 'connecting' || this.connectionState === 'reconnecting')) {
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
      const opts = { host, port, username, disableChatSigning: true }
      if (version) opts.version = version

      let msaCodeInfo = null
      if (auth === 'microsoft') {
        opts.auth = 'microsoft'
        opts.authFlow = 'sisu'
        opts.profilesFolder = process.env.MC_AUTH_CACHE || path.join(process.env.HOME, '.minecraft', 'nmp-cache')
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
        this.lastKeepalive = Date.now()
        // Track keepalive packets for watchdog liveness detection
        this.bot._client.on('keep_alive', (packet) => {
          this.lastKeepalive = Date.now()
        })
        // Install raw packet interceptor for lenient window_items parsing.
        // Must be after login because compression is set up during handshake.
        const loginMcData = minecraftData(this.bot.version)
        installRawPacketInterceptor(this.bot, loginMcData)
      })

      // Success: bot spawned
      this.bot.once('spawn', () => {
        console.error('Spawn event received')
        this.mcData = minecraftData(this.bot.version)
        this.connectionState = 'connected'
        this.reconnectAttempt = 0
        this.lastDisconnectReason = null
        console.error(`Connection state: connected as ${this.bot.username}`)

        // Detect wrong server on initial connect (e.g. reconnect lands on Hub)
        const expectedServer = process.env.MC_EXPECTED_SERVER
        if (expectedServer) {
          setTimeout(() => {
            if (!this.bot) return
            const gm = this.bot.game?.gameMode
            if (gm === 'adventure' || gm === 2) {
              console.error(`[spawn] Wrong server on initial connect (gameMode=${gm}), switching to ${expectedServer}`)
              this.bot.chat(`/server ${expectedServer}`)
            }
          }, 1000)
        }

        // Start Body agent loop
        this.onBotReady?.()

        const msg = msaCodeInfo
          ? `Connected as "${this.bot.username}" to ${host}:${port} (MC ${this.bot.version})\n\nNote: Microsoft auth was used. Token cached for future connections.`
          : `Connected as "${this.bot.username}" to ${host}:${port} (MC ${this.bot.version})`
        finish(true, text(msg))
      })

      // Re-initialize pathfinder after Velocity server transfers
      // When the proxy switches the backend server, Mineflayer emits a new
      // 'spawn' event but the pathfinder's internal world cache becomes stale.
      // Reloading the plugin forces it to re-read the fresh chunk data.
      let spawnCount = 0
      const expectedServer = process.env.MC_EXPECTED_SERVER  // e.g. "Mooshroomia"
      this.bot.on('spawn', () => {
        spawnCount++
        if (spawnCount > 1) {
          console.error(`[spawn #${spawnCount}] Server transfer detected, reloading pathfinder`)
          this.mcData = minecraftData(this.bot.version)
          // Stop any active pathfinding from the old server
          try { this.bot.pathfinder.stop() } catch (e) {}
          // Re-load the pathfinder plugin to reset its internal state
          this.bot.loadPlugin(pathfinder)

          // Detect wrong server (e.g. Velocity fallback to Hub after backend kick)
          // and switch back. Check after a short delay so gameMode has settled.
          if (expectedServer) {
            setTimeout(() => {
              if (!this.bot) return
              const gm = this.bot.game?.gameMode
              // Hub is adventure mode (2); Mooshroomia is survival (0)
              if (gm === 'adventure' || gm === 2) {
                console.error(`[spawn #${spawnCount}] Wrong server detected (gameMode=${gm}), switching to ${expectedServer}`)
                this.bot.chat(`/server ${expectedServer}`)
              }
            }, 1000)
          }
        }
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

          // Filter out private messages/whispers - bot is op so it sees these
          // Formats:
          //   [[PlayerName]] message  - op view of private messages
          //   [Player -> Player] message
          //   Player whispers to you: message
          if (/^\[\[[A-Za-z0-9_]+\]\]/.test(msgText) || /\s*->\s*/.test(msgText) || /whispers? to/i.test(msgText)) {
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
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason)
        this.lastDisconnectReason = `Kicked: ${reasonStr}`
        console.error('Kicked:', reasonStr)
      })

      this.bot.on('end', (reason) => {
        const wasConnected = this.connectionState === 'connected'
        const disconnectReason = this.lastDisconnectReason || reason || 'Connection closed'
        console.error('Disconnected:', disconnectReason)

        // Stop Reflexes before nulling bot
        this.reflexes?.stop()

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
    this.reconnectAttempt++
    // Fast backoff: 1s, 2s, 5s, 5s, 5s... (cap at 5s)
    const delays = [1000, 2000, 5000]
    const delay = delays[Math.min(this.reconnectAttempt - 1, delays.length - 1)]

    console.error(`[Reconnect] Attempt ${this.reconnectAttempt} in ${delay}ms...`)
    this.connectionState = 'reconnecting'

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect(this.connectArgs, true)
        console.error('[Reconnect] Successful')
      } catch (err) {
        console.error(`[Reconnect] Failed: ${err.message}`)
        // Explicitly schedule next attempt — the 'end' event won't trigger
        // another reconnect because connectionState is 'reconnecting', not
        // 'connected', so wasConnected will be false.
        this.scheduleReconnect()
      }
    }, delay)
  }

  mcp.startWatchdog = function() {
    if (this.watchdogTimer) return
    console.error('[Watchdog] Started (2s interval)')

    this.watchdogTimer = setInterval(() => {
      // Don't act if deliberately disconnected (no stored credentials)
      if (!this.connectArgs) return

      const state = this.connectionState
      const now = Date.now()

      // Stale "connected" state but bot is gone
      if (state === 'connected' && !this.bot) {
        console.error('[Watchdog] State says connected but bot is null — forcing reconnect')
        this.connectionState = 'disconnected'
        this.scheduleReconnect()
        return
      }

      // Connected but no keepalive for >35s — server likely dropped us
      if (state === 'connected' && this.bot && this.lastKeepalive && (now - this.lastKeepalive > 35000)) {
        console.error(`[Watchdog] No keepalive for ${Math.round((now - this.lastKeepalive) / 1000)}s — forcing reconnect`)
        this.lastKeepalive = null
        try { this.bot.quit() } catch (e) {}
        // The 'end' event handler will fire and call scheduleReconnect
        return
      }

      // Disconnected with credentials but nothing scheduled — fell through cracks
      if (state === 'disconnected' && !this.reconnectTimer) {
        console.error('[Watchdog] Disconnected with no pending reconnect — scheduling')
        this.scheduleReconnect()
      }
    }, 2000)
  }

  mcp.disconnect = function() {
    // Clear credentials to stop auto-reconnect and watchdog
    this.connectArgs = null
    this.reconnectAttempt = 0
    this.connectionState = 'disconnected'

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }

    if (this.bot) {
      this.bot.quit()
      this.bot = null
      this.mcData = null
      return text('Disconnected. Auto-reconnect disabled.')
    }
    return text('Not connected')
  }
}
