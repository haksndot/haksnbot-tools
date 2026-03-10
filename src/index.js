#!/usr/bin/env node

/**
 * Minecraft MCP Server
 *
 * Provides MCP tools for controlling a Minecraft bot using mineflayer.
 * Tools are organized into modules in the tools/ directory.
 *
 * Transport modes:
 *   stdio (default) — for Claude Code / Agent SDK stdio child process
 *   http            — standalone daemon on MCP_PORT (default 3100) for
 *                     Body agent + Mind agent to connect as MCP clients
 *
 * Set MCP_TRANSPORT=http to run as a standalone connection daemon.
 */

import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import express from 'express'
import mineflayer from 'mineflayer'
import minecraftData from 'minecraft-data'
import pathfinderPkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = pathfinderPkg
import Vec3Pkg from 'vec3'
const Vec3 = Vec3Pkg.Vec3 || Vec3Pkg

// Import Guts (survival instincts for connection daemon)
import { Guts } from 'haksnbot-guts'

// Import tool modules
import * as connectionTools from './tools/connection.js'
import * as observationTools from './tools/observation.js'
import * as movementTools from './tools/movement.js'
import * as communicationTools from './tools/communication.js'
import * as inventoryTools from './tools/inventory.js'
import * as containersTools from './tools/containers.js'
import * as craftingTools from './tools/crafting.js'
import * as combatTools from './tools/combat.js'
import * as sleepTools from './tools/sleep.js'
import * as signsTools from './tools/signs.js'
import * as buildingTools from './tools/building.js'
import * as animalsTools from './tools/animals.js'
import * as villagersTools from './tools/villagers.js'
import * as mountsTools from './tools/mounts.js'
import * as economyTools from './tools/economy.js'
import * as visionTools from './tools/vision.js'
import * as viewerTools from './tools/viewer.js'
import * as elytraTools from './tools/elytra.js'

const TRANSPORT = process.env.MCP_TRANSPORT || 'stdio'
const MCP_PORT = parseInt(process.env.MCP_PORT || '3100', 10)

// Make stdout non-blocking to prevent event loop stalls (stdio mode only).
// Node.js blocks on process.stdout.write() when stdout is a pipe and the
// reader (parent process) is slow.  This stalls the event loop and prevents
// mineflayer from responding to Velocity keepalive packets, causing the bot
// to be kicked after 30 seconds.
if (TRANSPORT === 'stdio' && process.stdout._handle && typeof process.stdout._handle.setBlocking === 'function') {
  process.stdout._handle.setBlocking(false)
  console.error('[haksnbot-tools] stdout set to non-blocking mode')
}

// Prevent MCP server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (handled):', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (handled):', reason)
})

// Collect all tool modules
const toolModules = [
  connectionTools,
  observationTools,
  movementTools,
  communicationTools,
  inventoryTools,
  containersTools,
  craftingTools,
  combatTools,
  sleepTools,
  signsTools,
  buildingTools,
  animalsTools,
  villagersTools,
  mountsTools,
  economyTools,
  visionTools,
  viewerTools,
  elytraTools
]

class MinecraftMCP {
  constructor() {
    this.bot = null
    this.mcData = null
    this.chatLog = []
    this.connectionState = 'disconnected'
    this.connectArgs = null
    this.lastDisconnectReason = null
    this.reconnectAttempt = 0
    this.lastKeepalive = null
    this.reconnectTimer = null
    this.watchdogTimer = null
    this.handlers = {}
    this.currentVillager = null
    this.xvfb = null
    this.physicalLock = null  // Name of tool holding the physical lock, or null
    this.guts = null

    // In HTTP mode, we create a new Server per session (each client gets its own).
    // In stdio mode, we use a single server instance like before.
    this._servers = new Map()  // sessionId -> Server (HTTP mode)

    // Register all tool handlers from modules
    for (const module of toolModules) {
      module.registerHandlers(this)
    }
  }

  // Helper to ensure bot is connected
  requireBot() {
    if (!this.bot) {
      if (this.connectionState === 'reconnecting') {
        throw new Error(`Reconnecting (attempt ${this.reconnectAttempt}). Watchdog will auto-reconnect. Please wait and try again.`)
      } else if (this.connectionState === 'connecting') {
        throw new Error('Connection in progress. Please wait and try again.')
      } else {
        const reason = this.lastDisconnectReason || 'Not connected'
        throw new Error(`${reason}. Watchdog will auto-reconnect.`)
      }
    }
  }

  _collectTools() {
    const allTools = []
    for (const module of toolModules) {
      allTools.push(...module.tools)
    }
    return allTools
  }

  // Physical tools that cause contention between Body and Mind
  static PHYSICAL_TOOLS = new Set([
    'break_block', 'place_block', 'place_sign', 'craft_item',
    'open_container', 'transfer_items', 'close_container',
    'interact_entity', 'open_villager_trades', 'trade_with_villager',
    'close_villager_trades', 'elytra_fly_to', 'sleep', 'wake',
    'equip_item',
    // Movement tools are also physical (Body calls these)
    'move_to', 'move_near', 'follow_player',
    'attack_entity',
  ])

  // Movement tools that set new pathfinding goals — should NOT auto-stop pathfinding
  static MOVEMENT_TOOLS = new Set(['move_to', 'move_near', 'follow_player'])

  async callTool(request) {
    const { name, arguments: args = {} } = request.params
    const isPhysical = MinecraftMCP.PHYSICAL_TOOLS.has(name)

    // Contention: if another physical tool is already running, return busy
    if (isPhysical && this.physicalLock) {
      return { content: [{ type: 'text', text: `Bot is busy (${this.physicalLock}). Try again shortly.` }], isError: true }
    }

    if (isPhysical) this.physicalLock = name
    try {
      // Auto-stop pathfinding before non-movement physical tools (e.g. open_container,
      // break_block) so the bot doesn't walk away mid-action
      if (isPhysical && !MinecraftMCP.MOVEMENT_TOOLS.has(name) && this.bot?.pathfinder) {
        this.bot.pathfinder.stop()
      }

      const handler = this.handlers[name]
      if (handler) {
        return await handler(args)
      }
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    } finally {
      if (isPhysical) this.physicalLock = null
    }
  }

  onBotReady() {
    // Start guts (eat, armor, combat, flee) in the connection daemon
    if (this.guts) {
      this.guts.start()
    }
  }

  _createServer() {
    const server = new Server(
      { name: 'haksnbot-tools', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this._collectTools() }))
    server.setRequestHandler(CallToolRequestSchema, (req) => this.callTool(req))
    return server
  }

  async runStdio() {
    // Register methods from all modules
    this._registerMethods()

    // Create Guts instance (starts when bot connects via onBotReady)
    this.guts = new Guts({
      getBot: () => this.bot,
      isLocked: () => !!this.physicalLock,
      onFlee: (x, y, z) => {
        if (this.bot?.pathfinder) {
          const { GoalBlock } = pathfinderPkg.goals
          this.bot.pathfinder.setGoal(new GoalBlock(x, y, z))
        }
      },
    })

    const server = this._createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('Minecraft MCP server running (stdio)')

    // Auto-connect if environment variables are set
    await this._autoConnect()
  }

  async runHttp() {
    // Register methods from all modules
    this._registerMethods()

    // Create Guts instance
    this.guts = new Guts({
      getBot: () => this.bot,
      isLocked: () => !!this.physicalLock,
      onFlee: (x, y, z) => {
        if (this.bot?.pathfinder) {
          const { GoalBlock } = pathfinderPkg.goals
          this.bot.pathfinder.setGoal(new GoalBlock(x, y, z))
        }
      },
    })

    // Map to store transports by session ID
    const transports = {}

    const app = express()
    app.use(express.json())

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        bot: this.connectionState,
        username: this.bot?.username || null,
      })
    })

    // MCP POST endpoint
    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id']

      try {
        let transport
        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId]
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New client connecting
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: sid => {
              console.error(`[MCP] New session: ${sid}`)
              transports[sid] = transport
            }
          })

          transport.onclose = () => {
            const sid = transport.sessionId
            if (sid && transports[sid]) {
              console.error(`[MCP] Session closed: ${sid}`)
              delete transports[sid]
            }
          }

          // Connect a new Server instance to this transport
          const server = this._createServer()
          await server.connect(transport)
          await transport.handleRequest(req, res, req.body)
          return
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID' },
            id: null
          })
          return
        }

        await transport.handleRequest(req, res, req.body)
      } catch (error) {
        console.error('[MCP] Error:', error.message)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          })
        }
      }
    })

    // SSE stream for notifications
    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id']
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      await transports[sessionId].handleRequest(req, res)
    })

    // Session termination
    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id']
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      await transports[sessionId].handleRequest(req, res)
    })

    app.listen(MCP_PORT, () => {
      console.error(`[Connect] MCP HTTP server listening on port ${MCP_PORT}`)
    })

    // Write PID file
    const fs = await import('fs')
    fs.writeFileSync('/tmp/haksnbot-connect.pid', String(process.pid))

    // Auto-connect bot
    await this._autoConnect()
  }

  _registerMethods() {
    connectionTools.registerMethods(this, mineflayer, minecraftData, pathfinder)
    observationTools.registerMethods(this, Vec3)
    movementTools.registerMethods(this, Vec3, Movements, goals)
    communicationTools.registerMethods(this)
    inventoryTools.registerMethods(this)
    containersTools.registerMethods(this, Vec3)
    craftingTools.registerMethods(this)
    combatTools.registerMethods(this)
    sleepTools.registerMethods(this, Vec3)
    signsTools.registerMethods(this, Vec3)
    buildingTools.registerMethods(this, Vec3)
    animalsTools.registerMethods(this, Vec3, Movements, goals)
    villagersTools.registerMethods(this, Vec3, Movements, goals)
    mountsTools.registerMethods(this, Vec3, Movements, goals)
    economyTools.registerMethods(this, Vec3)
    visionTools.registerMethods(this)
    viewerTools.registerMethods(this)
    elytraTools.registerMethods(this, Vec3)
  }

  async _autoConnect() {
    const host = process.env.MC_HOST
    const username = process.env.MC_USERNAME

    if (host && username) {
      console.error(`[Connect] Auto-connecting to ${host} as ${username}...`)
      try {
        await this.connect({
          host,
          port: parseInt(process.env.MC_PORT) || 25565,
          username,
          version: process.env.MC_VERSION,
          auth: process.env.MC_AUTH
        })
        console.error('[Connect] Auto-connect successful')
      } catch (err) {
        console.error(`[Connect] Auto-connect failed: ${err.message} — watchdog will retry`)
      }
      // Start watchdog regardless of whether initial connect succeeded
      this.startWatchdog()
    }
  }

  async run() {
    if (TRANSPORT === 'http') {
      await this.runHttp()
    } else {
      await this.runStdio()
    }
  }
}

const mcp = new MinecraftMCP()
mcp.run().catch(console.error)

process.on('SIGTERM', () => {
  console.error('[haksnbot-tools] SIGTERM received')
  if (mcp.watchdogTimer) clearInterval(mcp.watchdogTimer)
  if (mcp.reconnectTimer) clearTimeout(mcp.reconnectTimer)
  if (mcp.guts) mcp.guts.stop()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.error('[haksnbot-tools] SIGINT received')
  if (mcp.watchdogTimer) clearInterval(mcp.watchdogTimer)
  if (mcp.reconnectTimer) clearTimeout(mcp.reconnectTimer)
  if (mcp.guts) mcp.guts.stop()
  process.exit(0)
})
