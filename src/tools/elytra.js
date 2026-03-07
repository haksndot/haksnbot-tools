/**
 * Elytra flight tools - elytra_fly_to
 *
 * Non-blocking elytra flight. Kicks off the flight in the background and
 * returns immediately. The agent can check progress via get_status (position).
 *
 * IMPORTANT: The stop tool does NOT cancel elytra flight. Unlike ground
 * pathfinding where stopping means standing still, stopping mid-elytra-flight
 * means the bot stops steering while still hurtling through the air — i.e. a
 * crash. Elytra flights are committed; the bot flies until it arrives, lands
 * early (and re-takes off), or fails.
 */

import { text, error } from '../utils/helpers.js'
import elytraFly from '../utils/elytraFly.js'

export const tools = [
  {
    name: 'elytra_fly_to',
    description: `Fly to coordinates using elytra and firework rockets. Non-blocking: returns immediately while flight runs in background. Requires elytra (equipped or in inventory) and firework rockets. Automatically handles takeoff, cruise (boost/glide cycles with obstacle avoidance), and landing. For short distances (<30 blocks) falls back to walking. IMPORTANT: Elytra flight is a committed action — once airborne, the bot flies until it reaches the destination or fails. The "stop" tool does NOT cancel elytra flight (stopping mid-flight = crash). Cannot be called while a flight is already in progress. Use get_status to monitor progress.`,
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate' },
        y: { type: 'number', description: 'Target Y coordinate' },
        z: { type: 'number', description: 'Target Z coordinate' },
        vertical_takeoff: {
          type: 'boolean',
          description: 'Rocket straight up before cruising (use when taking off from tight spaces like forests or villages)',
          default: false
        }
      },
      required: ['x', 'y', 'z']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['elytra_fly_to'] = (args) => mcp.elytraFlyTo(args)
}

export function registerMethods(mcp, Vec3) {
  // Track active elytra flight state on the mcp instance
  mcp.elytraFlight = null // { destination, startTime, promise }

  mcp.elytraFlyTo = function({ x, y, z, vertical_takeoff = false }) {
    this.requireBot()

    // Reject if a flight is already in progress
    if (this.elytraFlight) {
      const dest = this.elytraFlight.destination
      return error(`Elytra flight already in progress (heading to ${Math.floor(dest.x)}, ${Math.floor(dest.y)}, ${Math.floor(dest.z)}). Wait for it to finish.`)
    }

    const pos = this.bot.entity.position
    const dest = new Vec3(x, y, z)
    const distance = Math.round(pos.distanceTo(dest))
    const startTime = Date.now()

    // Kick off flight in background
    const promise = elytraFly(this.bot, dest, {
      verticalTakeoff: vertical_takeoff
    }).then(result => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      if (result.result === 'success') {
        console.log(`[ElytraFly] Flight complete: ${distance} blocks in ${elapsed}s`)
      } else {
        console.warn(`[ElytraFly] Flight ended: ${result.result}${result.reason ? ' — ' + result.reason : ''} (${elapsed}s)`)
      }
      this.elytraFlight = null
      return result
    }).catch(err => {
      console.error(`[ElytraFly] Flight error: ${err.message}`)
      this.elytraFlight = null
      return { result: 'failed', reason: err.message }
    })

    this.elytraFlight = { destination: dest, startTime, promise }

    return text(`Elytra flight started: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)} → ${x}, ${y}, ${z} (${distance} blocks)${vertical_takeoff ? ' [vertical takeoff]' : ''}. Flight is committed — use get_status to monitor progress.`)
  }
}
