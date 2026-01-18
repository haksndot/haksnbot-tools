/**
 * Communication tools - chat, whisper, get_chat_history
 */

import { text } from '../utils/helpers.js'

export const tools = [
  {
    name: 'chat',
    description: 'Send a chat message (can include /commands if bot has permission)',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to send' }
      },
      required: ['message']
    }
  },
  {
    name: 'whisper',
    description: 'Send a private message to a player',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Player username' },
        message: { type: 'string', description: 'Message to send' }
      },
      required: ['username', 'message']
    }
  },
  {
    name: 'get_chat_history',
    description: 'Get recent chat and system messages (includes command outputs, deaths, server messages)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of messages', default: 20 }
      }
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['chat'] = (args) => mcp.chat(args)
  mcp.handlers['whisper'] = (args) => mcp.whisper(args)
  mcp.handlers['get_chat_history'] = (args) => mcp.getChatHistory(args)
}

export function registerMethods(mcp) {
  mcp.chat = function({ message }) {
    this.requireBot()
    this.bot.chat(message)
    return text(`Sent: ${message}`)
  }

  mcp.whisper = function({ username, message }) {
    this.requireBot()
    this.bot.whisper(username, message)
    return text(`Whispered to ${username}: ${message}`)
  }

  mcp.getChatHistory = function({ limit = 20 }) {
    const recent = this.chatLog.slice(-limit)
    if (recent.length === 0) {
      return text('No chat messages yet')
    }
    return text(recent.map(m => {
      const time = new Date(m.timestamp).toLocaleTimeString()
      if (m.type === 'system') {
        return `[${time}] [SYSTEM] ${m.message}`
      } else {
        return `[${time}] <${m.user}> ${m.message}`
      }
    }).join('\n'))
  }
}
