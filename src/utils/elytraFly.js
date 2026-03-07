/**
 * elytraFly.js — Physics-simulation-based elytra flight system for mineflayer bots.
 *
 * Uses prismarine-physics PlayerState to simulate trajectories ahead of time,
 * then picks the best yaw/pitch each tick to avoid obstacles and fly efficiently.
 *
 * Adapted from elytraFly.standalone.js for use as an ESM module in haksnbot-tools.
 */

import Vec3Pkg from 'vec3'
const Vec3 = Vec3Pkg.Vec3 || Vec3Pkg
import { PlayerState } from 'prismarine-physics'
import pathfinderPkg from 'mineflayer-pathfinder'
const { Movements, goals: { GoalNear } } = pathfinderPkg

// ── Conversion ───────────────────────────────────────────────────────────────
const DEG = Math.PI / 180

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — Tuning knobs for flight behavior
// ══════════════════════════════════════════════════════════════════════════════

// ── Flight planning ──────────────────────────────────────────────────────────
const BLOCKS_PER_ROCKET = 100
const SAFETY_MULTIPLIER = 2

// ── Boost cooldown ───────────────────────────────────────────────────────────
const BOOST_COOLDOWN_MS = 3000

// ── Distance thresholds ──────────────────────────────────────────────────────
const LANDING_DISTANCE = 50
const APPROACH_DISTANCE = 100
const ARRIVAL_DISTANCE = 8
const WALK_THRESHOLD = 30
const NAV_TICK_MS = 100

// ── Takeoff ──────────────────────────────────────────────────────────────────
const TAKEOFF_PITCH = 50 * DEG

// ── Elytra durability management ─────────────────────────────────────────────
const ELYTRA_SWAP_DURABILITY = 30
const ELYTRA_EMERGENCY_DURABILITY = 60

// ── Physics simulation / angle solver ────────────────────────────────────────
const SIM_TICKS = 60
const PITCH_STEP = 5 * DEG
const PITCH_DOWN_LIMIT = -30 * DEG
const PITCH_UP_LIMIT = 30 * DEG

const YAW_OFFSETS = [0, 15, -15, 30, -30, 45, -45].map(d => d * DEG)
const EVASIVE_YAW_OFFSETS = [60, -60, 90, -90, 120, -120, 150, -150, 180].map(d => d * DEG)

const MIN_ALTITUDE_ABOVE_TERRAIN = 20
const PREFERRED_ALTITUDE = 40
const SPIRAL_YAW_OFFSET = 35 * DEG
const EVASIVE_PITCH = 10 * DEG

// ── Boost/glide cruise cycle ─────────────────────────────────────────────────
const BOOST_CLIMB_PITCH = 70 * DEG
const APPROACH_BOOST_PITCH = 40 * DEG
const BOOST_DIVE_PITCH = -50 * DEG
const GLIDE_PITCH = -40 * DEG
const BOOST_DIVE_TICKS = 4
const POST_BOOST_RECOVERY_TICKS = 40
const GLIDE_MIN_ALTITUDE = 10

// ── Simulation control state ─────────────────────────────────────────────────
const SIM_CONTROL = {
  forward: false, back: false, left: false, right: false,
  jump: false, sprint: false, sneak: false
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function countRockets(bot) {
  return bot.inventory.items()
    .filter(i => i.name === 'firework_rocket')
    .reduce((sum, stack) => sum + stack.count, 0)
}

function hasElytraEquipped(bot) {
  const torsoSlot = bot.getEquipmentDestSlot('torso')
  const torsoItem = bot.inventory.slots[torsoSlot]
  return torsoItem && torsoItem.name === 'elytra'
}

function getTorsoItem(bot) {
  const torsoSlot = bot.getEquipmentDestSlot('torso')
  return bot.inventory.slots[torsoSlot] || null
}

function findElytraInInventory(bot) {
  return bot.inventory.items().find(i => i.name === 'elytra') || null
}

async function equipElytra(bot) {
  const previousTorso = getTorsoItem(bot)
  const elytra = findElytraInInventory(bot)
  if (!elytra) return null
  try {
    await bot.equip(elytra, 'torso')
    console.log(`[ElytraFly] Equipped elytra (was: ${previousTorso?.name || 'nothing'})`)
    return previousTorso
  } catch (err) {
    console.error('[ElytraFly] Failed to equip elytra:', err.message)
    return null
  }
}

async function reequipTorsoItem(bot, item) {
  if (!item) return
  try {
    const found = bot.inventory.items().find(i => i.name === item.name)
    if (found) {
      await bot.equip(found, 'torso')
      console.log(`[ElytraFly] Re-equipped ${item.name} in torso slot`)
    } else {
      console.warn(`[ElytraFly] Could not find ${item.name} in inventory to re-equip`)
    }
  } catch (err) {
    console.warn(`[ElytraFly] Failed to re-equip ${item.name}: ${err.message}`)
  }
}

async function equipRocket(bot) {
  const rocket = bot.inventory.items().find(i => i.name === 'firework_rocket')
  if (!rocket) return false
  try {
    await bot.equip(rocket, 'hand')
    return true
  } catch (err) {
    console.log(`[ElytraFly] Failed to equip rocket: ${err.message}`)
    return false
  }
}

function getRocketBaseDuration(item) {
  if (!item || item.name !== 'firework_rocket') return 20
  const flightDur = item.nbt?.value?.Fireworks?.value?.Flight?.value ?? 1
  return 10 * (flightDur + 1)
}

function getEquippedElytraDurability(bot) {
  const torso = getTorsoItem(bot)
  if (!torso || torso.name !== 'elytra') return null
  if (torso.maxDurability == null) return null
  return torso.maxDurability - (torso.durabilityUsed || 0)
}

function findBestElytraInInventory(bot) {
  const elytras = bot.inventory.items().filter(i => i.name === 'elytra')
  if (elytras.length === 0) return null
  return elytras.reduce((best, e) => {
    const dur = (e.maxDurability || 0) - (e.durabilityUsed || 0)
    const bestDur = (best.maxDurability || 0) - (best.durabilityUsed || 0)
    return dur > bestDur ? e : best
  })
}

async function checkElytraDurability(bot) {
  const remaining = getEquippedElytraDurability(bot)
  if (remaining === null) return 'ok'

  if (remaining >= ELYTRA_SWAP_DURABILITY) return 'ok'

  const spare = findBestElytraInInventory(bot)
  if (spare) {
    const spareDur = (spare.maxDurability || 0) - (spare.durabilityUsed || 0)
    if (spareDur > remaining) {
      try {
        await bot.equip(spare, 'torso')
        console.log(`[ElytraFly] Swapped elytra (${remaining} dur → ${spareDur} dur)`)
        return 'swapped'
      } catch (err) {
        console.warn(`[ElytraFly] Failed to swap elytra: ${err.message}`)
      }
    }
  }

  if (remaining < ELYTRA_EMERGENCY_DURABILITY) {
    console.warn(`[ElytraFly] Last elytra at ${remaining} durability, emergency landing`)
    return 'emergency_land'
  }

  return 'ok'
}

// ══════════════════════════════════════════════════════════════════════════════
// COLLISION HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const HITBOX_OFFSETS = [
  [0, 0, 0], [0, 1, 0], [0, 1.8, 0],
  [1, 0.9, 0], [-1, 0.9, 0],
  [0, 0.9, 1], [0, 0.9, -1],
  [0.7, 0.9, 0.7], [-0.7, 0.9, -0.7],
  [0.7, 0.9, -0.7], [-0.7, 0.9, 0.7],
  [0, -1, 0],
]

function checkCollision(bot, pos) {
  for (const [ox, oy, oz] of HITBOX_OFFSETS) {
    try {
      const block = bot.blockAt(new Vec3(pos.x + ox, pos.y + oy, pos.z + oz), false)
      if (block && block.boundingBox === 'block') return true
    } catch (_) {
      return true
    }
  }
  return false
}

function getTerrainAltitude(bot, pos) {
  for (let y = Math.floor(pos.y) - 1; y >= Math.max(pos.y - 60, -64); y--) {
    try {
      const block = bot.blockAt(new Vec3(pos.x, y, pos.z), false)
      if (block && block.boundingBox === 'block') return y + 1
    } catch (_) {
      return -64
    }
  }
  return -64
}

// ══════════════════════════════════════════════════════════════════════════════
// PHYSICS SIMULATION
// ══════════════════════════════════════════════════════════════════════════════

function createSimState(bot) {
  return new PlayerState(bot, SIM_CONTROL)
}

function cloneSimState(state) {
  return {
    pos: state.pos.clone(),
    vel: state.vel.clone(),
    onGround: state.onGround,
    isInWater: state.isInWater,
    isInLava: state.isInLava,
    isInWeb: state.isInWeb,
    isCollidedHorizontally: state.isCollidedHorizontally,
    isCollidedVertically: state.isCollidedVertically,
    elytraFlying: state.elytraFlying,
    jumpTicks: state.jumpTicks,
    jumpQueued: state.jumpQueued,
    fireworkRocketDuration: state.fireworkRocketDuration,
    attributes: state.attributes,
    yaw: state.yaw,
    pitch: state.pitch,
    control: SIM_CONTROL,
    jumpBoost: state.jumpBoost,
    speed: state.speed,
    slowness: state.slowness,
    dolphinsGrace: state.dolphinsGrace,
    slowFalling: state.slowFalling,
    levitation: state.levitation,
    depthStrider: state.depthStrider,
    elytraEquipped: state.elytraEquipped,
  }
}

function simulateTrajectory(bot, baseState, yaw, pitch, ticks, rocketDuration) {
  const state = cloneSimState(baseState)
  state.yaw = yaw
  state.pitch = pitch
  if (rocketDuration !== undefined) {
    state.fireworkRocketDuration = rocketDuration
  }

  const world = { getBlock: (pos) => bot.blockAt(pos, false) }
  const positions = []

  for (let t = 0; t < ticks; t++) {
    try {
      bot.physics.simulatePlayer(state, world)
    } catch (_) {
      return { positions, finalPos: state.pos.clone(), finalVel: state.vel.clone(), collided: true, collideTick: t }
    }
    positions.push(state.pos.clone())

    if (checkCollision(bot, state.pos)) {
      return { positions, finalPos: state.pos.clone(), finalVel: state.vel.clone(), collided: true, collideTick: t }
    }

    if (!state.elytraFlying) {
      return { positions, finalPos: state.pos.clone(), finalVel: state.vel.clone(), collided: false, collideTick: t }
    }
  }

  return { positions, finalPos: state.pos.clone(), finalVel: state.vel.clone(), collided: false, collideTick: -1 }
}

// ══════════════════════════════════════════════════════════════════════════════
// ANGLE SOLVER
// ══════════════════════════════════════════════════════════════════════════════

function pitchCandidates() {
  const pitches = []
  for (let p = PITCH_DOWN_LIMIT; p <= PITCH_UP_LIMIT + 0.001; p += PITCH_STEP) {
    pitches.push(p)
  }
  return pitches
}

function scoreTrajectory(bot, result, destination, isLanding) {
  if (result.collided) return Infinity

  const finalDist = result.finalPos.distanceTo(destination)
  let score = finalDist

  if (!isLanding) {
    let worstAltitude = Infinity
    const step = Math.max(1, Math.floor(result.positions.length / 8))
    for (let i = 0; i < result.positions.length; i += step) {
      const p = result.positions[i]
      const terrainY = getTerrainAltitude(bot, p)
      const alt = p.y - terrainY
      if (alt < worstAltitude) worstAltitude = alt
    }
    const finalTerrainY = getTerrainAltitude(bot, result.finalPos)
    const finalAlt = result.finalPos.y - finalTerrainY
    if (finalAlt < worstAltitude) worstAltitude = finalAlt

    if (worstAltitude < MIN_ALTITUDE_ABOVE_TERRAIN) {
      const deficit = MIN_ALTITUDE_ABOVE_TERRAIN - worstAltitude
      score += deficit * deficit * 2
    }

    if (worstAltitude < PREFERRED_ALTITUDE) {
      score += (PREFERRED_ALTITUDE - worstAltitude) * 0.5
    }

    if (result.finalPos.y > result.positions[0]?.y) {
      score -= Math.min(10, (result.finalPos.y - result.positions[0].y) * 0.3)
    }
  }

  const speed = Math.sqrt(
    result.finalVel.x * result.finalVel.x +
    result.finalVel.y * result.finalVel.y +
    result.finalVel.z * result.finalVel.z
  )
  if (speed < 0.3) {
    score += (0.3 - speed) * 50
  }

  return score
}

function solveAngles(bot, baseState, destination, isLanding) {
  const pos = baseState.pos
  const dx = destination.x - pos.x
  const dz = destination.z - pos.z
  const dy = destination.y - pos.y
  const horizontalDist = Math.sqrt(dx * dx + dz * dz)
  const directYaw = Math.atan2(-dx, -dz)

  const idealPitch = Math.max(PITCH_DOWN_LIMIT, Math.min(PITCH_UP_LIMIT,
    Math.atan2(dy, horizontalDist)
  ))

  // Level 0: Direct aim
  const directResult = simulateTrajectory(bot, baseState, directYaw, idealPitch, SIM_TICKS)
  const directScore = scoreTrajectory(bot, directResult, destination, isLanding)
  if (directScore < Infinity && directScore < pos.distanceTo(destination) + 20) {
    return { yaw: directYaw, pitch: idealPitch, needsBoost: false }
  }

  // Level 1: Pitch sweep at direct yaw
  let bestScore = Infinity
  let bestYaw = directYaw
  let bestPitch = idealPitch

  const pitches = pitchCandidates()

  for (const pitch of pitches) {
    const result = simulateTrajectory(bot, baseState, directYaw, pitch, SIM_TICKS)
    const score = scoreTrajectory(bot, result, destination, isLanding)
    if (score < bestScore) {
      bestScore = score
      bestYaw = directYaw
      bestPitch = pitch
    }
  }

  if (bestScore < Infinity) {
    return { yaw: bestYaw, pitch: bestPitch, needsBoost: false }
  }

  // Level 2: Yaw + pitch spread
  for (const yawOffset of YAW_OFFSETS) {
    if (yawOffset === 0) continue
    const testYaw = directYaw + yawOffset

    for (const pitch of pitches) {
      const result = simulateTrajectory(bot, baseState, testYaw, pitch, SIM_TICKS)
      const score = scoreTrajectory(bot, result, destination, isLanding)
      if (score < bestScore) {
        bestScore = score
        bestYaw = testYaw
        bestPitch = pitch
      }
    }
  }

  if (bestScore < Infinity) {
    return { yaw: bestYaw, pitch: bestPitch, needsBoost: false }
  }

  // Level 3: Evasive turn
  for (const yawOffset of EVASIVE_YAW_OFFSETS) {
    const testYaw = directYaw + yawOffset

    for (const pitch of pitches) {
      const result = simulateTrajectory(bot, baseState, testYaw, pitch, SIM_TICKS)
      const score = scoreTrajectory(bot, result, destination, isLanding)
      if (score < bestScore) {
        bestScore = score
        bestYaw = testYaw
        bestPitch = pitch
      }
    }
  }

  if (bestScore < Infinity) {
    console.log(`[ElytraFly] Evasive turn: yaw offset ${((bestYaw - directYaw) / DEG).toFixed(0)}°`)
    return { yaw: bestYaw, pitch: bestPitch, needsBoost: false }
  }

  // All options collide — turn 90° with slight climb
  console.warn('[ElytraFly] No valid trajectory found, evasive turn')
  return { yaw: directYaw + 90 * DEG, pitch: EVASIVE_PITCH, needsBoost: false }
}

// ══════════════════════════════════════════════════════════════════════════════
// TAKEOFF HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const TAKEOFF_SEARCH_RADIUS = 30
const MAX_RETAKEOFFS = 5

function isSolidAt(bot, x, y, z) {
  try {
    const block = bot.blockAt(new Vec3(x, y, z), false)
    return block && block.boundingBox === 'block'
  } catch (_) {
    return true
  }
}

function hasTakeoffClearance(bot, pos, yaw) {
  for (let dy = 1; dy <= 4; dy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        if (isSolidAt(bot, pos.x + ox, pos.y + dy, pos.z + oz)) return false
      }
    }
  }

  const horizStep = Math.cos(TAKEOFF_PITCH)
  const vertStep = Math.sin(TAKEOFF_PITCH)
  const dirX = -Math.sin(yaw)
  const dirZ = Math.cos(yaw)

  const MARGIN = 0.5
  const hitboxOffsets = [
    [0, 0], [MARGIN, 0], [-MARGIN, 0], [0, MARGIN], [0, -MARGIN],
    [MARGIN, MARGIN], [-MARGIN, MARGIN], [MARGIN, -MARGIN], [-MARGIN, -MARGIN],
  ]

  for (let step = 1; step <= 8; step++) {
    const dist = step * 1.5
    const cx = pos.x + dirX * horizStep * dist
    const cy = pos.y + 1 + vertStep * dist
    const cz = pos.z + dirZ * horizStep * dist

    for (const [hx, hz] of hitboxOffsets) {
      if (isSolidAt(bot, cx + hx, cy, cz + hz)) return false
      if (isSolidAt(bot, cx + hx, cy + 1, cz + hz)) return false
    }
  }

  return true
}

function findClearTakeoffSpot(bot, yaw) {
  const origin = bot.entity.position.floored()

  if (hasTakeoffClearance(bot, origin, yaw)) return null

  for (let radius = 2; radius <= TAKEOFF_SEARCH_RADIUS; radius += 2) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
      const x = origin.x + Math.round(Math.cos(angle) * radius)
      const z = origin.z + Math.round(Math.sin(angle) * radius)

      let groundY = null
      for (let y = origin.y + 5; y >= origin.y - 10; y--) {
        try {
          const block = bot.blockAt(new Vec3(x, y, z), false)
          const blockAbove = bot.blockAt(new Vec3(x, y + 1, z), false)
          if (block && block.boundingBox === 'block' &&
              (!blockAbove || blockAbove.boundingBox !== 'block')) {
            groundY = y + 1
            break
          }
        } catch (_) {
          break
        }
      }

      if (groundY !== null) {
        const candidate = new Vec3(x, groundY, z)
        if (hasTakeoffClearance(bot, candidate, yaw)) {
          return candidate
        }
      }
    }
  }

  return null
}

function hasOpenSky(bot, pos) {
  for (let dy = 1; dy <= 20; dy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        if (isSolidAt(bot, pos.x + ox, pos.y + dy, pos.z + oz)) return false
      }
    }
  }
  return true
}

function findOpenSkySpot(bot) {
  const origin = bot.entity.position.floored()
  if (hasOpenSky(bot, origin)) return null

  for (let radius = 2; radius <= TAKEOFF_SEARCH_RADIUS; radius += 2) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
      const x = origin.x + Math.round(Math.cos(angle) * radius)
      const z = origin.z + Math.round(Math.sin(angle) * radius)

      let groundY = null
      for (let y = origin.y + 5; y >= origin.y - 10; y--) {
        try {
          const block = bot.blockAt(new Vec3(x, y, z), false)
          const blockAbove = bot.blockAt(new Vec3(x, y + 1, z), false)
          if (block && block.boundingBox === 'block' &&
              (!blockAbove || blockAbove.boundingBox !== 'block')) {
            groundY = y + 1
            break
          }
        } catch (_) {
          break
        }
      }

      if (groundY !== null) {
        const candidate = new Vec3(x, groundY, z)
        if (hasOpenSky(bot, candidate)) return candidate
      }
    }
  }
  return null
}

async function performVerticalTakeoff(bot, isActive) {
  const MAX_CLEARANCE_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_CLEARANCE_ATTEMPTS; attempt++) {
    if (hasOpenSky(bot, bot.entity.position.floored())) break

    if (attempt === 0) {
      console.log('[ElytraFly] No open sky here, searching for clear spot...')
    } else {
      console.log(`[ElytraFly] Still no open sky (attempt ${attempt + 1}), searching again...`)
    }

    const clearSpot = findOpenSkySpot(bot)
    if (clearSpot) {
      console.log(`[ElytraFly] Walking to open sky spot at ${clearSpot.x}, ${clearSpot.y}, ${clearSpot.z}`)
      const reached = await walkTo(bot, clearSpot, isActive)
      if (!reached || !isActive()) return false
      await sleep(200)
    } else {
      console.warn('[ElytraFly] No open sky spot found nearby, attempting vertical takeoff anyway')
      break
    }
  }

  await equipRocket(bot)

  await bot.look(bot.entity.yaw, Math.PI / 2)
  bot.setControlState('jump', true)
  bot.setControlState('jump', false)
  await sleep(80)

  if (!isActive()) return false

  await bot.elytraFly()
  await sleep(50)

  bot.activateItem()
  console.log('[ElytraFly] Vertical takeoff: first rocket fired')

  let boostEndTime = Date.now() + getRocketBaseDuration(bot.heldItem) * 50

  const MAX_CLIMB_TIME = 15000
  const climbStart = Date.now()

  while (isActive() && bot.entity.elytraFlying) {
    if (Date.now() - climbStart > MAX_CLIMB_TIME) {
      console.warn('[ElytraFly] Vertical takeoff: max climb time reached')
      break
    }

    const pos = bot.entity.position
    const terrainY = getTerrainAltitude(bot, pos)
    const altAboveTerrain = pos.y - terrainY

    if (altAboveTerrain >= PREFERRED_ALTITUDE) {
      console.log(`[ElytraFly] Vertical takeoff: reached altitude ${Math.round(altAboveTerrain)} above terrain`)
      break
    }

    await bot.look(bot.entity.yaw, Math.PI / 2)

    if (Date.now() >= boostEndTime - 200) {
      if (countRockets(bot) > 0) {
        await equipRocket(bot)
        bot.activateItem()
        boostEndTime = Date.now() + getRocketBaseDuration(bot.heldItem) * 50
        console.log(`[ElytraFly] Vertical takeoff: chaining rocket (alt ${Math.round(altAboveTerrain)})`)
      } else {
        console.warn('[ElytraFly] Vertical takeoff: ran out of rockets during climb')
        break
      }
    }

    await sleep(NAV_TICK_MS)
  }

  return bot.entity.elytraFlying === true
}

async function walkTo(bot, pos, isActive, timeoutMs = 15000) {
  if (!bot.pathfinder) {
    console.warn('[ElytraFly] Pathfinder not available for walking')
    return false
  }

  const savedMovements = bot.pathfinder.movements
  const safeMove = new Movements(bot)
  safeMove.canPlaceOn = false
  safeMove.allow1by1towers = false
  safeMove.allowParkour = true
  safeMove.canDig = false
  bot.pathfinder.setMovements(safeMove)

  return new Promise((resolve) => {
    const goal = new GoalNear(pos.x, pos.y, pos.z, 2)
    let resolved = false

    const finish = (result) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      bot.removeListener('goal_reached', onGoalReached)
      bot.removeListener('path_stop', onPathStopped)
      try { bot.pathfinder.setMovements(savedMovements) } catch (_) {}
      resolve(result)
    }

    const onGoalReached = () => finish(true)
    const onPathStopped = () => finish(false)

    const timer = setTimeout(() => {
      try { bot.pathfinder.setGoal(null) } catch (_) {}
      finish(false)
    }, timeoutMs)

    bot.on('goal_reached', onGoalReached)
    bot.on('path_stop', onPathStopped)

    try {
      bot.pathfinder.setGoal(goal)
    } catch (err) {
      finish(false)
    }
  })
}

async function performTakeoff(bot, destination, isActive) {
  const yawToTarget = Math.atan2(
    -(destination.x - bot.entity.position.x),
    -(destination.z - bot.entity.position.z)
  )

  const MAX_CLEARANCE_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_CLEARANCE_ATTEMPTS; attempt++) {
    if (hasTakeoffClearance(bot, bot.entity.position.floored(), yawToTarget)) break

    if (attempt === 0) {
      console.log('[ElytraFly] No takeoff clearance here, searching for clear spot...')
    } else {
      console.log(`[ElytraFly] Takeoff spot still blocked (attempt ${attempt + 1}), searching again...`)
    }

    const clearSpot = findClearTakeoffSpot(bot, yawToTarget)
    if (clearSpot) {
      console.log(`[ElytraFly] Walking to clear takeoff spot at ${clearSpot.x}, ${clearSpot.y}, ${clearSpot.z}`)
      const reached = await walkTo(bot, clearSpot, isActive)
      if (!reached || !isActive()) return false
      await sleep(200)
    } else {
      console.warn('[ElytraFly] No clear takeoff spot found nearby, attempting takeoff anyway')
      break
    }
  }

  await equipRocket(bot)

  const finalYaw = Math.atan2(
    -(destination.x - bot.entity.position.x),
    -(destination.z - bot.entity.position.z)
  )
  await bot.look(finalYaw, TAKEOFF_PITCH)

  bot.setControlState('jump', true)
  bot.setControlState('jump', false)
  await sleep(80)

  if (!isActive()) return false

  await bot.elytraFly()
  await sleep(50)

  const takeoffRocketDur = getRocketBaseDuration(bot.heldItem)
  bot.activateItem()
  console.log(`[ElytraFly] Takeoff boost activated (${takeoffRocketDur} tick rocket)`)

  if (takeoffRocketDur <= 20 && countRockets(bot) > 0) {
    const waitMs = (takeoffRocketDur + 5) * 50
    await sleep(waitMs)
    if (isActive() && bot.entity.elytraFlying &&
        bot.heldItem && bot.heldItem.name === 'firework_rocket') {
      bot.activateItem()
      console.log('[ElytraFly] Takeoff second boost (duration 1 rockets, sequential)')
    }
  }

  await sleep(500)

  return bot.entity.elytraFlying === true
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN FLIGHT FUNCTION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Fly via elytra from current position to destination.
 *
 * @param {object} bot - mineflayer bot instance
 * @param {Vec3} destination - target position
 * @param {object} [options]
 * @param {function} [options.isActive] - callback returning false to cancel flight
 * @param {number}   [options.tolerance] - arrival distance (default 8)
 * @param {boolean}  [options.verticalTakeoff] - rocket straight up first
 * @returns {Promise<{result: string, reason?: string}>}
 */
async function elytraFly(bot, destination, options = {}) {
  const isActive = options.isActive || (() => true)
  const tolerance = options.tolerance || ARRIVAL_DISTANCE

  // ── Phase 1: Validation ──────────────────────────────────────────────

  let previousTorsoItem = null

  if (!hasElytraEquipped(bot)) {
    if (!findElytraInInventory(bot)) {
      console.warn('[ElytraFly] No elytra equipped or in inventory')
      return { result: 'no_elytra' }
    }
    previousTorsoItem = await equipElytra(bot)
    if (!hasElytraEquipped(bot)) {
      return { result: 'no_elytra' }
    }
  }

  const rocketCount = countRockets(bot)
  if (rocketCount === 0) {
    console.warn('[ElytraFly] No firework rockets in inventory')
    if (previousTorsoItem) await reequipTorsoItem(bot, previousTorsoItem)
    return { result: 'no_rockets' }
  }

  const distance = bot.entity.position.distanceTo(destination)

  if (distance < WALK_THRESHOLD) {
    console.log(`[ElytraFly] Destination only ${Math.round(distance)} blocks away, walking instead of flying`)
    if (previousTorsoItem) await reequipTorsoItem(bot, previousTorsoItem)
    const walked = await walkTo(bot, destination, isActive, 30000)
    return { result: walked ? 'success' : 'failed', reason: walked ? undefined : 'Walk failed' }
  }

  const estimatedRockets = Math.ceil(distance / BLOCKS_PER_ROCKET) * SAFETY_MULTIPLIER

  if (estimatedRockets > rocketCount) {
    const reason = `Need ~${estimatedRockets} rockets for ${Math.round(distance)} blocks, have ${rocketCount}`
    console.warn(`[ElytraFly] Insufficient rockets: ${reason}`)
    if (previousTorsoItem) await reequipTorsoItem(bot, previousTorsoItem)
    return { result: 'insufficient_rockets', reason }
  }

  console.log(`[ElytraFly] Elytra flight: ${Math.round(distance)} blocks, est. ${estimatedRockets} rockets (have ${rocketCount})`)

  // ── Phase 2+3: Takeoff → Fly → Land ──────────────────────────────────

  let retakeoffCount = 0

  try {
    while (isActive()) {

      const useVertical = options.verticalTakeoff && retakeoffCount === 0
      try {
        const airborne = useVertical
          ? await performVerticalTakeoff(bot, isActive)
          : await performTakeoff(bot, destination, isActive)
        if (!isActive()) return { result: 'cancelled' }
        if (!airborne) {
          console.warn('[ElytraFly] Takeoff did not achieve flight')
          if (retakeoffCount >= MAX_RETAKEOFFS) {
            return { result: 'failed', reason: `Failed to take off after ${MAX_RETAKEOFFS} attempts` }
          }
          retakeoffCount++
          await sleep(500)
          continue
        }
        console.log(`[ElytraFly] Airborne (takeoff #${retakeoffCount + 1}${useVertical ? ', vertical' : ''})`)
      } catch (err) {
        console.error('[ElytraFly] Takeoff failed:', err.message)
        if (retakeoffCount >= MAX_RETAKEOFFS) {
          bot.clearControlStates()
          return { result: 'failed', reason: 'Takeoff failed: ' + err.message }
        }
        retakeoffCount++
        await sleep(500)
        continue
      }

      // ── Navigation loop ─────────────────────────────────────────────

      let lastBoostTime = Date.now()
      let lastPosition = bot.entity.position.clone()
      let stuckTicks = 0
      let spiralSign = 1
      let earlyLanding = false
      let durabilityCheckCounter = 0

      let boostActive
      let boostTicksRemaining = 0
      let postBoostRecoveryTicks
      let boostQueueSecond = false

      if (useVertical) {
        boostActive = false
        postBoostRecoveryTicks = 0
      } else {
        boostActive = true
        postBoostRecoveryTicks = POST_BOOST_RECOVERY_TICKS
        const initRocketDur = getRocketBaseDuration(bot.heldItem)
        boostTicksRemaining = initRocketDur <= 20 ? initRocketDur * 2 : initRocketDur
      }

      while (isActive()) {
        if (!bot.entity.elytraFlying) {
          const remaining = bot.entity.position.distanceTo(destination)
          if (remaining <= tolerance * 3) {
            console.log('[ElytraFly] Landed near destination, close enough')
            return { result: 'success' }
          }
          console.log(`[ElytraFly] Early landing ${Math.round(remaining)} blocks from destination, will re-takeoff`)
          earlyLanding = true
          break
        }

        const pos = bot.entity.position
        const dx = destination.x - pos.x
        const dz = destination.z - pos.z
        const horizontalDist = Math.sqrt(dx * dx + dz * dz)
        const totalDist = pos.distanceTo(destination)

        if (totalDist <= tolerance) {
          console.log(`[ElytraFly] Reached elytra destination (${Math.round(distance)} blocks flown)`)
          return { result: 'success' }
        }

        durabilityCheckCounter++
        if (durabilityCheckCounter >= 10) {
          durabilityCheckCounter = 0
          const durStatus = await checkElytraDurability(bot)
          if (durStatus === 'emergency_land') {
            return { result: 'failed', reason: 'Elytra durability critical' }
          }
        }

        if (boostActive) {
          boostTicksRemaining -= 2
          if (boostTicksRemaining <= 0 || bot.fireworkRocketDuration <= 0) {
            if (boostQueueSecond) {
              boostQueueSecond = false
              if (bot.heldItem && bot.heldItem.name === 'firework_rocket') {
                bot.activateItem()
                const secondDur = getRocketBaseDuration(bot.heldItem)
                boostTicksRemaining = secondDur
                console.log(`[ElytraFly] Second rocket fired (${secondDur} ticks)`)
              } else {
                boostActive = false
                boostTicksRemaining = 0
                postBoostRecoveryTicks = 0
              }
            } else {
              boostActive = false
              boostTicksRemaining = 0
              postBoostRecoveryTicks = 0
            }
          }
        } else if (postBoostRecoveryTicks < POST_BOOST_RECOVERY_TICKS) {
          postBoostRecoveryTicks += 2
        }

        const directYaw = Math.atan2(-dx, -dz)
        const altAboveDest = pos.y - destination.y
        const terrainY = getTerrainAltitude(bot, pos)
        const altAboveTerrain = pos.y - terrainY

        // ── Landing phase ──────────────────────────────────────────────
        const isLanding = horizontalDist < LANDING_DISTANCE && altAboveDest > 0 && horizontalDist < 30

        let targetYaw = directYaw
        let targetPitch

        if (isLanding) {
          let solution
          try {
            const baseState = createSimState(bot)
            const descentPitch = Math.max(-40 * DEG, Math.min(-8 * DEG,
              Math.atan2(-altAboveDest, horizontalDist)))

            if (horizontalDist < 12 && altAboveDest < 15) {
              const finalPitch = Math.max(-45 * DEG, Math.min(-10 * DEG,
                Math.atan2(-altAboveDest, horizontalDist)))
              const finalResult = simulateTrajectory(bot, baseState, directYaw, finalPitch, SIM_TICKS)
              if (!finalResult.collided) {
                solution = { yaw: directYaw, pitch: finalPitch }
              }
            }

            if (!solution) {
              const wideYaw = directYaw + (50 * DEG * spiralSign)
              const wideResult = simulateTrajectory(bot, baseState, wideYaw, descentPitch, SIM_TICKS)
              if (!wideResult.collided) {
                solution = { yaw: wideYaw, pitch: descentPitch }
              }
            }

            if (!solution) {
              const stdYaw = directYaw + (SPIRAL_YAW_OFFSET * spiralSign)
              const stdResult = simulateTrajectory(bot, baseState, stdYaw, descentPitch, SIM_TICKS)
              if (!stdResult.collided) {
                solution = { yaw: stdYaw, pitch: descentPitch }
              }
            }

            if (!solution) {
              const narrowYaw = directYaw + (20 * DEG * spiralSign)
              const narrowResult = simulateTrajectory(bot, baseState, narrowYaw, descentPitch, SIM_TICKS)
              if (!narrowResult.collided) {
                solution = { yaw: narrowYaw, pitch: descentPitch }
              }
            }

            if (!solution) {
              solution = solveAngles(bot, baseState, destination, true)
            }
          } catch (err) {
            console.log('[ElytraFly] Landing solver error:', err.message)
            solution = { yaw: directYaw + (SPIRAL_YAW_OFFSET * spiralSign), pitch: -10 * DEG }
          }

          targetYaw = solution.yaw
          targetPitch = solution.pitch

        } else if (boostActive) {
          const nearLanding = totalDist < APPROACH_DISTANCE
          if (!boostQueueSecond && boostTicksRemaining <= BOOST_DIVE_TICKS) {
            targetPitch = BOOST_DIVE_PITCH
          } else {
            targetPitch = nearLanding ? APPROACH_BOOST_PITCH : BOOST_CLIMB_PITCH
          }
          targetYaw = directYaw

          try {
            const baseState = createSimState(bot)
            const result = simulateTrajectory(bot, baseState, targetYaw, targetPitch, 20)
            if (result.collided) {
              const solution = solveAngles(bot, baseState, destination, false)
              targetYaw = solution.yaw
              targetPitch = solution.pitch
            }
          } catch (_) {}

        } else if (postBoostRecoveryTicks < POST_BOOST_RECOVERY_TICKS) {
          const t = postBoostRecoveryTicks / POST_BOOST_RECOVERY_TICKS
          targetPitch = BOOST_DIVE_PITCH + (GLIDE_PITCH - BOOST_DIVE_PITCH) * t
          targetYaw = directYaw

          try {
            const baseState = createSimState(bot)
            const result = simulateTrajectory(bot, baseState, targetYaw, targetPitch, 20)
            if (result.collided) {
              const solution = solveAngles(bot, baseState, destination, false)
              targetYaw = solution.yaw
              targetPitch = solution.pitch
            }
          } catch (_) {}

        } else {
          try {
            const baseState = createSimState(bot)
            const solution = solveAngles(bot, baseState, destination, false)
            targetYaw = solution.yaw
            targetPitch = solution.pitch
          } catch (err) {
            console.log('[ElytraFly] Glide solver error:', err.message)
            targetPitch = GLIDE_PITCH
          }
        }

        await bot.look(targetYaw, targetPitch)

        // ── Rocket boost decision ──────────────────────────────────────
        const now = Date.now()
        const elapsed = NAV_TICK_MS / 1000
        const speed = pos.distanceTo(lastPosition) / elapsed

        if (!isLanding && !boostActive && now - lastBoostTime > BOOST_COOLDOWN_MS) {
          const approaching = totalDist < APPROACH_DISTANCE
          const minAlt = approaching ? 15 : GLIDE_MIN_ALTITUDE
          const prefAlt = approaching ? 25 : PREFERRED_ALTITUDE
          const needsAltitude = altAboveTerrain < minAlt
          const isDescending = bot.entity.velocity.y < -0.1
          const shouldBoost = needsAltitude || (isDescending && altAboveTerrain < prefAlt)

          if (shouldBoost) {
            if (!bot.heldItem || bot.heldItem.name !== 'firework_rocket') {
              const hasRocket = await equipRocket(bot)
              if (!hasRocket) {
                console.warn('[ElytraFly] Ran out of rockets mid-flight, gliding remaining distance')
              }
            }
            if (bot.heldItem && bot.heldItem.name === 'firework_rocket') {
              const rocketDur = getRocketBaseDuration(bot.heldItem)
              const isShortRocket = rocketDur <= 20
              bot.activateItem()

              boostActive = true
              boostTicksRemaining = rocketDur
              if (isShortRocket && countRockets(bot) > 0) {
                boostQueueSecond = true
                console.log(`[ElytraFly] Rocket boost (${rocketDur} ticks, 2nd queued), alt ${Math.round(altAboveTerrain)}, ${Math.round(totalDist)} blocks remaining`)
              } else {
                boostQueueSecond = false
                console.log(`[ElytraFly] Rocket boost (${rocketDur} ticks), alt ${Math.round(altAboveTerrain)}, ${Math.round(totalDist)} blocks remaining`)
              }

              postBoostRecoveryTicks = POST_BOOST_RECOVERY_TICKS
              lastBoostTime = now
            }
          }
        }

        // ── Stuck detection ────────────────────────────────────────────

        if (speed < 1) {
          stuckTicks++
          if (stuckTicks > 30) {
            console.warn('[ElytraFly] Stuck during elytra flight')
            return { result: 'failed', reason: 'Stuck during flight' }
          }
        } else {
          stuckTicks = 0
        }

        lastPosition = pos.clone()
        await sleep(NAV_TICK_MS)
      }

      // ── Early landing recovery ──────────────────────────────────────
      if (earlyLanding) {
        await sleep(500)
        if (!isActive()) return { result: 'cancelled' }

        const remainAfterLanding = bot.entity.position.distanceTo(destination)
        if (remainAfterLanding < WALK_THRESHOLD) {
          console.log(`[ElytraFly] ${Math.round(remainAfterLanding)} blocks remaining, walking to destination`)
          const walked = await walkTo(bot, destination, isActive, 30000)
          return { result: walked ? 'success' : 'failed', reason: walked ? undefined : 'Walk to destination failed' }
        }

        retakeoffCount++
        if (retakeoffCount > MAX_RETAKEOFFS) {
          console.warn(`[ElytraFly] Exceeded max re-takeoff attempts (${MAX_RETAKEOFFS})`)
          return { result: 'failed', reason: 'Too many early landings' }
        }

        if (!hasElytraEquipped(bot)) {
          if (!findElytraInInventory(bot)) {
            console.warn('[ElytraFly] Elytra lost after early landing')
            return { result: 'failed', reason: 'Elytra lost' }
          }
          await equipElytra(bot)
        }

        const durCheck = await checkElytraDurability(bot)
        if (durCheck === 'emergency_land') {
          return { result: 'failed', reason: 'Elytra durability critical, cannot re-fly' }
        }

        if (countRockets(bot) === 0) {
          console.warn('[ElytraFly] No rockets remaining after early landing')
          return { result: 'no_rockets' }
        }

        console.log(`[ElytraFly] Re-takeoff attempt ${retakeoffCount}/${MAX_RETAKEOFFS}`)
        continue
      }

      return { result: 'cancelled' }
    }

    return { result: 'cancelled' }
  } finally {
    bot.clearControlStates()
    if (previousTorsoItem) {
      await reequipTorsoItem(bot, previousTorsoItem)
    }
  }
}

export default elytraFly
