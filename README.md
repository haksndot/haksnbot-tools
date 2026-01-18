# haksnbot-tools

An MCP (Model Context Protocol) server that gives Claude the ability to play Minecraft. Built on [Mineflayer](https://github.com/PrismarineJS/mineflayer), this tool lets Claude Code (or any MCP-compatible AI) control a Minecraft bot with 40+ actions.

> **Part of the Haksnbot suite:** This project was originally developed as part of [Haksnbot](https://github.com/haksndot), an autonomous Minecraft bot. The suite includes four repos that work together: [haksnbot-tools](https://github.com/haksndot/haksnbot-tools) (this repo - Minecraft bot control), [haksnbot-agent](https://github.com/haksndot/haksnbot-agent) (the autonomous agent), [haksnbot-admin](https://github.com/haksndot/haksnbot-admin) (server administration), and [haksnbot-memory](https://github.com/haksndot/haksnbot-memory) (persistent memory). Each can be used independently, but they're designed to work together.

## Features

- **Full bot control** - Movement, combat, building, crafting, inventory management
- **Microsoft authentication** - Works with online-mode servers
- **Pathfinding** - Automatic navigation using mineflayer-pathfinder
- **Auto-reconnect** - Handles disconnections with exponential backoff
- **Vision** - 3D rendered screenshots of what the bot sees
- **Villager trading** - Browse and execute trades
- **Shop integration** - Works with QuickShop-Hikari plugin for player economies

## Installation

```bash
git clone https://github.com/haksndot/haksnbot-tools.git
cd haksnbot-tools
npm install
```

## Usage with Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "node",
      "args": ["/path/to/haksnbot-tools/src/index.js"]
    }
  }
}
```

Then in Claude Code:

```
> Connect to my Minecraft server at mc.example.com as "ClaudeBot"
> What's around me?
> Find some oak trees and chop wood
> Craft a crafting table and wooden pickaxe
```

## Available Tools (40+)

### Connection
| Tool | Description |
|------|-------------|
| `connect` | Connect to a Minecraft server (supports Microsoft auth) |
| `disconnect` | Disconnect from server (stops auto-reconnect) |
| `get_connection_status` | Check state: disconnected, connecting, connected, reconnecting |

### Status & Observation
| Tool | Description |
|------|-------------|
| `get_status` | Position, health, hunger, gamemode, dimension |
| `get_block_at` | Block type at coordinates |
| `scan_area` | Scan blocks in radius, returns counts by type |
| `find_blocks` | Find nearest blocks of type (e.g., diamond_ore) |
| `get_nearby_entities` | List mobs, animals, items in range |
| `get_nearby_players` | List players in range |

### Movement
| Tool | Description |
|------|-------------|
| `move_to` | Pathfind to exact coordinates |
| `move_near` | Pathfind to within range of coordinates |
| `follow_player` | Follow a player by username |
| `look_at` | Turn to face coordinates |
| `stop` | Stop current movement |

### Communication
| Tool | Description |
|------|-------------|
| `chat` | Send chat message (supports /commands) |
| `whisper` | Private message to a player |
| `get_chat_history` | Recent chat, deaths, announcements |

### Inventory
| Tool | Description |
|------|-------------|
| `get_inventory` | List inventory items |
| `get_held_item` | Currently held item |
| `equip_item` | Equip to hand or armor slot |

### Containers
| Tool | Description |
|------|-------------|
| `open_container` | Open chest, furnace, etc. |
| `get_container_contents` | List container items |
| `transfer_items` | Move items to/from container |
| `close_container` | Close container |

### Crafting
| Tool | Description |
|------|-------------|
| `get_craftable_items` | Items craftable with current inventory |
| `get_recipe` | Get recipe for an item |
| `craft_item` | Craft an item (auto-uses crafting table) |

### Combat & Interaction
| Tool | Description |
|------|-------------|
| `attack_entity` | Attack nearest entity of type |
| `use_item` | Use held item (right-click) |
| `interact_entity` | Feed animals, milk cows, shear sheep |

### Sleep
| Tool | Description |
|------|-------------|
| `sleep` | Find bed and sleep |
| `wake` | Wake up from bed |

### Building
| Tool | Description |
|------|-------------|
| `place_block` | Place block at coordinates |
| `break_block` | Break block (auto-equips best tool) |
| `place_sign` | Place and write on sign |
| `read_sign` | Read sign text |
| `edit_sign` | Edit existing sign |

### Villager Trading
| Tool | Description |
|------|-------------|
| `find_villagers` | Find villagers with professions |
| `open_villager_trades` | View available trades |
| `trade_with_villager` | Execute a trade |
| `close_villager_trades` | Close trade window |

### Mounts & Vehicles
| Tool | Description |
|------|-------------|
| `mount_entity` | Mount horse, pig, boat, minecart |
| `dismount` | Dismount from vehicle |

### Economy (QuickShop-Hikari)
| Tool | Description |
|------|-------------|
| `list_all_shops` | List all player shops |
| `search_shops` | Search shops by item |
| `create_chest_shop` | Create a chest shop |

### Vision
| Tool | Description |
|------|-------------|
| `take_screenshot` | 3D rendered screenshot |
| `get_player_skin` | Download player skin as PNG |

## Authentication

### Offline-mode servers
```
connect to localhost as "MyBot"
```

### Online-mode servers (Microsoft auth)
```
connect to mc.example.com as "myemail@outlook.com" with microsoft auth
```

On first connection, enter the device code at microsoft.com/link. Tokens are cached for future use.

```bash
# Manage auth tokens
node auth.js status myemail@outlook.com
node auth.js login myemail@outlook.com
node auth.js logout myemail@outlook.com
```

## Auto-Reconnect

Automatic reconnection with exponential backoff:
- Initial delay: 2 seconds
- Max delay: ~5 minutes
- Max attempts: 10

Use `disconnect` to fully stop the bot.

## Plugin Integrations

These tools were originally developed for a server running [GriefPrevention](https://github.com/TechFortress/GriefPrevention) and [QuickShop-Hikari](https://github.com/Ghost-chu/QuickShop-Hikari) plugins. The bot has built-in support for these plugins, but **all features work without them** - they gracefully degrade when the plugins are not present.

### GriefPrevention (Claim Protection)

The bot automatically detects claim protection when performing actions. On servers with GriefPrevention, the bot:

- **Checks claim ownership** before modifying blocks or containers
- **Respects trust levels** (uses `/trustlist` to check permissions)
- **Reports denials clearly** so you know why an action failed

**Tools with GriefPrevention awareness:**

| Tool | Behavior with GriefPrevention |
|------|-------------------------------|
| `break_block` | Checks if bot can break blocks in the claim |
| `place_block` | Checks if bot can build in the claim |
| `place_sign` | Checks container/build trust for sign placement |
| `edit_sign` | Checks permission to modify signs |
| `open_container` | Checks container trust before opening chests |
| `interact_entity` | Checks if bot can interact with animals in claims |
| `mount_entity` | Checks permission to mount animals/vehicles in claims |
| `create_chest_shop` | Verifies claim ownership before creating shops |

**Without GriefPrevention:** All tools work normally. The bot simply won't detect claim-based denials (vanilla protection like spawn protection still applies).

### QuickShop-Hikari (Player Economy)

For servers with QuickShop-Hikari, the bot can query and interact with player shops. These features require the `MC_SERVER_ROOT` environment variable pointing to your Minecraft server directory.

**Configuration:**

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "node",
      "args": ["/path/to/haksnbot-tools/src/index.js"],
      "env": {
        "MC_SERVER_ROOT": "/path/to/minecraft-server"
      }
    }
  }
}
```

**Shop tools:**

| Tool | Description |
|------|-------------|
| `list_all_shops` | Query all shops from the QuickShop H2 database |
| `search_shops` | Search for shops selling/buying a specific item |
| `create_chest_shop` | Create a QuickShop chest shop at coordinates |

**Without QuickShop or MC_SERVER_ROOT:** These three tools return a helpful error message: "QuickShop features require MC_SERVER_ROOT environment variable". All other tools work normally.

### Graceful Degradation Summary

| Plugin | If Not Present |
|--------|----------------|
| GriefPrevention | All tools work; claim checks are skipped |
| QuickShop-Hikari | Shop tools (`list_all_shops`, `search_shops`, `create_chest_shop`) return error; all other tools work |

## Requirements

- Node.js 18+
- For `take_screenshot`: OpenGL support (Mesa on Linux)

## Dependencies

- [mineflayer](https://github.com/PrismarineJS/mineflayer) - Minecraft bot framework
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) - Pathfinding
- [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) - 3D rendering
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk) - MCP server SDK

## Related Projects

- [haksnbot-agent](https://github.com/haksndot/haksnbot-agent) - Autonomous Minecraft bot using Claude Agent SDK
- [haksnbot-admin](https://github.com/haksndot/haksnbot-admin) - Server administration MCP tools

## License

MIT
