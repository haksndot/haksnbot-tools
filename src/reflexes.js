/**
 * Reflexes — survival actions that run directly on the mineflayer bot.
 *
 * Extracted from body.js. These run in the connection daemon on a fast
 * interval (2s) and handle eating and armor equipping without any LLM call.
 * Combat is NOT included here — it stays in the Body agent for when it's needed.
 */

// Armor slot priority: best first
const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet']
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
const ARMOR_SLOT_NAMES = {
  head: ['helmet'],
  torso: ['chestplate'],
  legs: ['leggings'],
  feet: ['boots'],
}

// Food items sorted by saturation (best first)
const FOOD_ITEMS = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
  'cooked_salmon', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod',
  'bread', 'baked_potato', 'beetroot_soup', 'mushroom_stew',
  'suspicious_stew', 'rabbit_stew', 'apple', 'melon_slice',
  'sweet_berries', 'glow_berries', 'carrot', 'potato',
  'beetroot', 'dried_kelp', 'cookie',
]

const REFLEX_INTERVAL = 2000  // 2 seconds

export class Reflexes {
  constructor(mcp) {
    this.mcp = mcp
    this.timer = null
    this.running = false
  }

  start() {
    if (this.running) return
    this.running = true
    console.error('[Reflex] Started (2s interval)')
    this._scheduleTick()
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    console.error('[Reflex] Stopped')
  }

  _scheduleTick() {
    if (!this.running) return
    this.timer = setTimeout(() => this._tick(), REFLEX_INTERVAL)
  }

  async _tick() {
    if (!this.running) return

    const bot = this.mcp.bot
    if (!bot?.entity) {
      this._scheduleTick()
      return
    }

    // Don't interfere when a tool is active
    if (this.mcp.physicalLock) {
      this._scheduleTick()
      return
    }

    try {
      // 1. Eat if any hunger at all and we have food
      const food = bot.food
      if (food < 20) {
        const foodItem = bot.inventory.items().find(i => FOOD_ITEMS.includes(i.name))
        if (foodItem) {
          await bot.equip(foodItem, 'hand')
          await bot.consume()
          console.error(`[Reflex] Ate ${foodItem.name}`)
          this._scheduleTick()
          return
        }
      }

      // 2. Equip better armor
      const armorSlots = bot.inventory.slots
      const slotMap = { 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }
      const equipped = {}
      for (const [slot, name] of Object.entries(slotMap)) {
        const item = armorSlots[parseInt(slot)]
        equipped[name] = item ? item.name : null
      }

      for (const item of bot.inventory.items()) {
        for (const [slot, suffixes] of Object.entries(ARMOR_SLOT_NAMES)) {
          if (suffixes.some(s => item.name.endsWith(s)) && equipped[slot] !== item.name) {
            // Check if this is actually better armor
            const currentTier = equipped[slot]
              ? ARMOR_TIERS.findIndex(t => equipped[slot].includes(t))
              : ARMOR_TIERS.length
            const newTier = ARMOR_TIERS.findIndex(t => item.name.includes(t))
            if (newTier >= 0 && (currentTier < 0 || newTier < currentTier)) {
              await bot.equip(item, slot)
              console.error(`[Reflex] Equipped ${item.name} to ${slot}`)
              this._scheduleTick()
              return
            }
          }
        }
      }
    } catch (e) {
      console.error(`[Reflex] Error: ${e.message}`)
    }

    this._scheduleTick()
  }
}

// Export constants for use by get_body_state tool
export { FOOD_ITEMS, ARMOR_SLOTS, ARMOR_TIERS, ARMOR_SLOT_NAMES }
