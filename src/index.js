#!/usr/bin/env node

/**
 * Minecraft MCP Server
 *
 * Provides MCP tools for controlling a Minecraft bot using mineflayer.
 * Tools are organized into modules in the tools/ directory.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import mineflayer from 'mineflayer'
import minecraftData from 'minecraft-data'
import pathfinderPkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = pathfinderPkg
import Vec3Pkg from 'vec3'
const Vec3 = Vec3Pkg.Vec3 || Vec3Pkg

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
  visionTools
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
    this.maxReconnectAttempts = 10
    this.baseReconnectDelay = 2000
    this.handlers = {}
    this.currentVillager = null
    this.xvfb = null

    this.server = new Server(
      { name: 'minecraft-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )

    this.server.setRequestHandler(ListToolsRequestSchema, () => this.listTools())
    this.server.setRequestHandler(CallToolRequestSchema, (req) => this.callTool(req))

    // Register all tool handlers from modules
    for (const module of toolModules) {
      module.registerHandlers(this)
    }
  }

  // Helper to ensure bot is connected
  requireBot() {
    if (!this.bot) {
      if (this.connectionState === 'reconnecting') {
        throw new Error(`Reconnecting (attempt ${this.reconnectAttempt}/${this.maxReconnectAttempts}). Please wait and try again.`)
      } else if (this.connectionState === 'connecting') {
        throw new Error('Connection in progress. Please wait and try again.')
      } else {
        const reason = this.lastDisconnectReason || 'Not connected'
        throw new Error(`${reason}. Auto-reconnect will retry if credentials are stored.`)
      }
    }
  }

  listTools() {
    // Collect tools from all modules
    const allTools = []
    for (const module of toolModules) {
      allTools.push(...module.tools)
    }
    return { tools: allTools }
  }

  async callTool(request) {
    const { name, arguments: args = {} } = request.params

    try {
      const handler = this.handlers[name]
      if (handler) {
        return await handler(args)
      }
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  }

  async run() {
    // Register methods from all modules, passing required dependencies
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

    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    console.error('Minecraft MCP server running')

    // Auto-connect if environment variables are set
    const host = process.env.MC_HOST
    const username = process.env.MC_USERNAME
    if (host && username) {
      console.error(`Auto-connecting to ${host} as ${username}...`)
      try {
        await this.connect({
          host,
          port: parseInt(process.env.MC_PORT) || 25565,
          username,
          version: process.env.MC_VERSION,
          auth: process.env.MC_AUTH
        })
        console.error('Auto-connect successful')
      } catch (err) {
        console.error(`Auto-connect failed: ${err.message}`)
      }
    }
  }
}

const mcp = new MinecraftMCP()
mcp.run().catch(console.error)
