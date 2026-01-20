/**
 * Helper utilities for MCP responses and common operations
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Get absolute path to repo root (minecraft-mcp is a sibling of agent)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

// Bot message log file - the agent tails this for real-time notifications
const BOT_MESSAGE_LOG = process.env.BOT_MESSAGE_LOG ||
  path.join(REPO_ROOT, 'agent', 'data', 'bot-messages.log')

// Ensure log directory exists
try {
  fs.mkdirSync(path.dirname(BOT_MESSAGE_LOG), { recursive: true })
} catch (e) {
  // Ignore if already exists
}

/**
 * Log a message received by the bot to the message log file.
 * The agent tails this file to get real-time notifications of bot messages.
 */
export function logBotMessage(type, content, extra = {}) {
  const timestamp = new Date().toISOString()
  const logLine = JSON.stringify({ timestamp, type, content, ...extra }) + '\n'
  try {
    fs.appendFileSync(BOT_MESSAGE_LOG, logLine)
  } catch (e) {
    console.error('Failed to write bot message log:', e.message)
  }
}

// Helper for consistent text responses
export function text(msg) {
  return { content: [{ type: 'text', text: msg }] }
}

// Helper for JSON responses
export function json(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
}

// Helper for error responses
export function error(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
}

// Helper for fuzzy entity type matching (handles version differences in mob names)
export function matchesEntityType(entity, targetType) {
  const target = targetType.toLowerCase().replace(/_/g, '')
  const name = (entity.name || '').toLowerCase().replace(/_/g, '')
  const mobType = (entity.mobType || '').toLowerCase().replace(/_/g, '')
  return name === target || mobType === target ||
         name.includes(target) || target.includes(name)
}
