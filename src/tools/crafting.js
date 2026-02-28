/**
 * Crafting tools - get_craftable_items, get_recipe, craft_item
 */

import { text, json, error } from '../utils/helpers.js'

export const tools = [
  {
    name: 'get_craftable_items',
    description: 'List items that can be crafted with current inventory. Set use_crafting_table=true for 3x3 recipes (requires nearby crafting table).',
    inputSchema: {
      type: 'object',
      properties: {
        use_crafting_table: { type: 'boolean', description: 'Include 3x3 recipes (needs nearby crafting table)', default: false }
      }
    }
  },
  {
    name: 'get_recipe',
    description: 'Get the crafting recipe for an item',
    inputSchema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Item name to get recipe for (e.g. chest, diamond_pickaxe)' }
      },
      required: ['item_name']
    }
  },
  {
    name: 'craft_item',
    description: 'Craft an item. Automatically uses nearby crafting table for 3x3 recipes.',
    inputSchema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Item name to craft' },
        count: { type: 'number', description: 'Number to craft (default: 1)', default: 1 }
      },
      required: ['item_name']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['get_craftable_items'] = (args) => mcp.getCraftableItems(args)
  mcp.handlers['get_recipe'] = (args) => mcp.getRecipe(args)
  mcp.handlers['craft_item'] = async (args) => mcp.craftItem(args)
}

export function registerMethods(mcp) {
  mcp.findCraftingTable = function() {
    const craftingTableType = this.mcData.blocksByName['crafting_table']
    if (!craftingTableType) return null

    const tables = this.bot.findBlocks({
      matching: craftingTableType.id,
      maxDistance: 4,
      count: 1
    })

    return tables.length > 0 ? this.bot.blockAt(tables[0]) : null
  }

  mcp.getCraftableItems = function({ use_crafting_table = false }) {
    this.requireBot()

    const craftingTable = use_crafting_table ? this.findCraftingTable() : null
    if (use_crafting_table && !craftingTable) {
      return error('No crafting table found within 4 blocks. Move closer to a crafting table or set use_crafting_table=false.')
    }

    const inventory = this.bot.inventory.items()
    const itemCounts = {}
    for (const item of inventory) {
      itemCounts[item.name] = (itemCounts[item.name] || 0) + item.count
    }

    const craftable = []
    for (const [itemId, recipes] of Object.entries(this.mcData.recipes)) {
      const item = this.mcData.items[itemId]
      if (!item) continue

      for (const recipe of recipes) {
        // Check if recipe requires crafting table (3x3)
        const requires3x3 = recipe.inShape && (recipe.inShape.length > 2 ||
          recipe.inShape.some(row => row && row.length > 2))

        if (requires3x3 && !craftingTable) continue

        const maxCraftable = this.getMaxCraftable(recipe)
        if (maxCraftable > 0) {
          craftable.push({
            name: item.name,
            count_craftable: maxCraftable,
            result_count: recipe.result?.count || 1,
            requires_crafting_table: requires3x3
          })
          break // Only show one recipe per item
        }
      }
    }

    return json({
      inventory_summary: itemCounts,
      using_crafting_table: !!craftingTable,
      craftable_items: craftable.sort((a, b) => a.name.localeCompare(b.name))
    })
  }

  mcp.getMaxCraftable = function(recipe) {
    const inventory = this.bot.inventory.items()
    const itemCounts = {}
    for (const item of inventory) {
      itemCounts[item.type] = (itemCounts[item.type] || 0) + item.count
    }

    let maxCrafts = Infinity

    // Get required ingredients
    const required = {}
    if (recipe.ingredients) {
      for (const ing of recipe.ingredients) {
        if (ing) {
          const id = typeof ing === 'number' ? ing : ing.id
          required[id] = (required[id] || 0) + 1
        }
      }
    } else if (recipe.inShape) {
      for (const row of recipe.inShape) {
        if (row) {
          for (const ing of row) {
            if (ing) {
              const id = typeof ing === 'number' ? ing : ing.id
              required[id] = (required[id] || 0) + 1
            }
          }
        }
      }
    }

    for (const [itemId, count] of Object.entries(required)) {
      const have = itemCounts[itemId] || 0
      maxCrafts = Math.min(maxCrafts, Math.floor(have / count))
    }

    return maxCrafts === Infinity ? 0 : maxCrafts
  }

  mcp.getRecipe = function({ item_name }) {
    this.requireBot()

    const item = this.mcData.itemsByName[item_name]
    if (!item) {
      return error(`Unknown item: ${item_name}`)
    }

    const recipes = this.mcData.recipes[item.id]
    if (!recipes || recipes.length === 0) {
      return text(`No crafting recipe found for ${item_name}`)
    }

    const formattedRecipes = recipes.map((recipe, idx) => {
      const result = {
        recipe_index: idx,
        result_count: recipe.result?.count || 1
      }

      if (recipe.inShape) {
        result.type = 'shaped'
        result.shape = recipe.inShape.map(row =>
          row ? row.map(ing => {
            if (!ing) return null
            const id = typeof ing === 'number' ? ing : ing.id
            return {
              name: this.mcData.items[id]?.name || `id:${id}`,
              count: ing.count || 1
            }
          }) : []
        )
      } else if (recipe.ingredients) {
        result.type = 'shapeless'
        result.ingredients = recipe.ingredients.map(ing => {
          if (!ing) return null
          const id = typeof ing === 'number' ? ing : ing.id
          return {
            name: this.mcData.items[id]?.name || `id:${id}`,
            count: ing.count || 1
          }
        }).filter(i => i)
      }

      return result
    })

    return json({
      item: item_name,
      recipes: formattedRecipes
    })
  }

  mcp.craftItem = async function({ item_name, count = 1 }) {
    this.requireBot()

    const item = this.mcData.itemsByName[item_name]
    if (!item) {
      return error(`Unknown item: ${item_name}`)
    }

    // First check if a crafting table is nearby (for 3x3 recipes)
    let craftingTable = this.findCraftingTable()

    // Use bot.recipesFor() to get proper mineflayer Recipe objects
    // This handles ingredient matching correctly
    const recipes = this.bot.recipesFor(item.id, null, 1, craftingTable)

    if (!recipes || recipes.length === 0) {
      // Try without crafting table to give a helpful message
      const recipesWithoutTable = this.bot.recipesFor(item.id, null, 1, null)
      if (recipesWithoutTable && recipesWithoutTable.length > 0) {
        // Check if any recipe needs a crafting table (3x3)
        const mcDataRecipes = this.mcData.recipes[item.id] || []
        const needs3x3 = mcDataRecipes.some(r =>
          r.inShape && (r.inShape.length > 2 || r.inShape.some(row => row && row.length > 2))
        )
        if (needs3x3 && !craftingTable) {
          return error(`${item_name} requires a crafting table. None found within 4 blocks.`)
        }
      }

      // List what ingredients we have and what's needed
      const inventory = this.bot.inventory.items()
      const itemCounts = {}
      for (const invItem of inventory) {
        itemCounts[invItem.name] = (itemCounts[invItem.name] || 0) + invItem.count
      }

      return error(`Cannot craft ${item_name}: insufficient materials. Inventory: ${JSON.stringify(itemCounts)}`)
    }

    // Use the first available recipe
    const recipe = recipes[0]

    try {
      await this.bot.craft(recipe, count, craftingTable)
      return text(`Crafted ${count}x ${item_name}`)
    } catch (err) {
      return error(`Failed to craft ${item_name}: ${err.message}`)
    }
  }
}
