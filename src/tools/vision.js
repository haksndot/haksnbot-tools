/**
 * Vision tools - take_screenshot, get_player_skin
 */

import { text, json, error } from '../utils/helpers.js'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'

export const tools = [
  {
    name: 'take_screenshot',
    description: 'Take a 3D rendered screenshot of what the bot sees. Returns a first-person view image using prismarine-viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Image width in pixels (default 512)', default: 512 },
        height: { type: 'number', description: 'Image height in pixels (default 512)', default: 512 },
        view_distance: { type: 'number', description: 'View distance in chunks (default 32)', default: 32 }
      }
    }
  },
  {
    name: 'get_player_skin',
    description: 'Fetch a Minecraft player skin image. Downloads the skin texture and saves it as a PNG file. Returns the file path for viewing.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Minecraft username to look up' },
        save_dir: { type: 'string', description: 'Directory to save the skin image (default: /tmp)', default: '/tmp' }
      },
      required: ['username']
    }
  }
]

export function registerHandlers(mcp) {
  mcp.handlers['take_screenshot'] = async (args) => mcp.takeScreenshot(args)
  mcp.handlers['get_player_skin'] = async (args) => mcp.getPlayerSkin(args)
}

export function registerMethods(mcp) {
  // Helper to make HTTP/HTTPS GET request
  mcp.httpGet = function(url) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      protocol.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect
          this.httpGet(res.headers.location).then(resolve).catch(reject)
          return
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    })
  }

  mcp.getPlayerSkin = async function({ username, save_dir = '/tmp' }) {
    // Step 1: Get UUID from Mojang API
    let uuid
    try {
      const profileData = await this.httpGet(`https://api.mojang.com/users/profiles/minecraft/${username}`)
      const profile = JSON.parse(profileData.toString())
      if (!profile.id) {
        return error(`Player "${username}" not found`)
      }
      uuid = profile.id
    } catch (err) {
      if (err.message === 'HTTP 404') {
        return error(`Player "${username}" not found`)
      }
      return error(`Failed to look up player: ${err.message}`)
    }

    // Format UUID with dashes
    const uuidFormatted = `${uuid.slice(0,8)}-${uuid.slice(8,12)}-${uuid.slice(12,16)}-${uuid.slice(16,20)}-${uuid.slice(20)}`

    // Step 2: Get session profile with skin data
    let skinUrl, capeUrl, modelType
    try {
      const sessionData = await this.httpGet(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`)
      const session = JSON.parse(sessionData.toString())

      if (!session.properties || session.properties.length === 0) {
        return error('No texture data found for player')
      }

      const texturesProp = session.properties.find(p => p.name === 'textures')
      if (!texturesProp) {
        return error('No textures property found')
      }

      // Decode base64 textures value
      const texturesJson = Buffer.from(texturesProp.value, 'base64').toString()
      const textures = JSON.parse(texturesJson)

      if (textures.textures && textures.textures.SKIN) {
        skinUrl = textures.textures.SKIN.url
        modelType = textures.textures.SKIN.metadata?.model || 'classic'
      }
      if (textures.textures && textures.textures.CAPE) {
        capeUrl = textures.textures.CAPE.url
      }
    } catch (err) {
      return error(`Failed to get skin data: ${err.message}`)
    }

    if (!skinUrl) {
      return error('No skin found for player (may be using default skin)')
    }

    // Step 3: Download skin image
    let skinData
    try {
      skinData = await this.httpGet(skinUrl)
    } catch (err) {
      return error(`Failed to download skin: ${err.message}`)
    }

    // Step 4: Save to file
    const timestamp = Date.now()
    const skinFilePath = path.join(save_dir, `${username}_skin_${timestamp}.png`)

    try {
      fs.writeFileSync(skinFilePath, skinData)
    } catch (err) {
      // File save failed, but we can still return the image data
    }

    // Download cape if present
    let capeData = null
    if (capeUrl) {
      try {
        capeData = await this.httpGet(capeUrl)
      } catch (err) {
        // Cape download failed, continue without it
      }
    }

    // Return response with embedded image data
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          username,
          uuid: uuidFormatted,
          model_type: modelType,
          skin_url: skinUrl,
          cape_url: capeUrl || null,
          skin_file: skinFilePath
        }, null, 2)
      },
      {
        type: 'image',
        data: skinData.toString('base64'),
        mimeType: 'image/png'
      }
    ]

    // Add cape image if available
    if (capeData) {
      content.push({
        type: 'image',
        data: capeData.toString('base64'),
        mimeType: 'image/png'
      })
    }

    return { content }
  }

  mcp.takeScreenshot = async function({ width = 512, height = 512, view_distance = 6 }) {
    this.requireBot()

    try {
      // Start virtual display if not already running
      if (!this.xvfb) {
        const { default: Xvfb } = await import('xvfb')
        this.xvfb = new Xvfb({ silent: true })
        this.xvfb.startSync()
      }

      // Polyfill browser globals for THREE.js
      if (!global.window) {
        global.requestAnimationFrame = (cb) => setTimeout(cb, 16)
        global.cancelAnimationFrame = (id) => clearTimeout(id)
        global.document = {
          createElement: () => ({ style: {} }),
          addEventListener: () => {},
          createElementNS: () => ({ style: {} })
        }
        global.window = {
          requestAnimationFrame: global.requestAnimationFrame,
          cancelAnimationFrame: global.cancelAnimationFrame,
          devicePixelRatio: 1,
          addEventListener: () => {},
          removeEventListener: () => {},
          innerWidth: width,
          innerHeight: height
        }
      }

      // Load THREE.js - needs window to exist
      if (!global.THREE) {
        const THREE = await import('three')
        global.THREE = THREE
      }

      // Set up Worker for meshing threads
      if (!global.Worker) {
        const { Worker } = await import('worker_threads')
        global.Worker = Worker
      }

      // Load prismarine-viewer module
      const nodeCanvasWebgl = await import('node-canvas-webgl/lib/index.js')
      const createCanvas = nodeCanvasWebgl.default?.createCanvas || nodeCanvasWebgl.createCanvas
      const prismarineViewer = await import('prismarine-viewer')
      const { WorldView, Viewer } = prismarineViewer.default.viewer

      // Create canvas and renderer
      const canvas = createCanvas(width, height)
      const renderer = new global.THREE.WebGLRenderer({ canvas })

      // CRITICAL: Temporarily remove window before creating Viewer
      const savedWindow = global.window
      delete global.window

      // Create viewer
      const viewer = new Viewer(renderer)

      // Restore window for runtime needs
      global.window = savedWindow

      // Set version
      if (!viewer.setVersion(this.bot.version)) {
        renderer.dispose()
        return error(`Unsupported Minecraft version: ${this.bot.version}`)
      }

      // Bot position and look direction
      const pos = this.bot.entity.position.clone()
      const yaw = this.bot.entity.yaw
      const pitch = this.bot.entity.pitch
      console.log(`[Screenshot] Captured position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) yaw=${(yaw * 180 / Math.PI).toFixed(1)}° pitch=${(pitch * 180 / Math.PI).toFixed(1)}°`)

      // Set camera position directly
      const eyeHeight = 1.62
      viewer.camera.position.set(pos.x, pos.y + eyeHeight, pos.z)
      viewer.camera.rotation.set(pitch, yaw, 0, 'ZYX')

      // Create world view
      const worldView = new WorldView(this.bot.world, view_distance, pos)
      viewer.listen(worldView)

      // Connect world view to bot's world events
      worldView.listenToBot(this.bot)

      // DEBUG: Track which chunks are loaded
      let chunkCount = 0
      const loadedChunkCoords = []
      worldView.on('loadChunk', (chunkPos) => {
        chunkCount++
        if (loadedChunkCoords.length < 10) {
          loadedChunkCoords.push({ x: chunkPos.x, z: chunkPos.z })
        }
      })

      // Load chunks from bot's world
      await worldView.init(pos)
      console.log(`[Screenshot DEBUG] worldView.init() completed, ${chunkCount} loadChunk events emitted`)

      // Wait for worker threads to finish meshing all chunks
      await viewer.waitForChunksToRender()
      console.log(`[Screenshot DEBUG] waitForChunksToRender() completed`)

      // Collect debug info
      const camera = viewer.camera
      let meshCount = 0
      let meshesWithVertices = 0
      let totalVertices = 0
      let minX = Infinity, maxX = -Infinity
      let minY = Infinity, maxY = -Infinity
      let minZ = Infinity, maxZ = -Infinity

      viewer.scene.traverse((obj) => {
        if (obj.isMesh) {
          meshCount++
          if (obj.geometry && obj.geometry.attributes && obj.geometry.attributes.position) {
            const vertCount = obj.geometry.attributes.position.count
            if (vertCount > 0) {
              meshesWithVertices++
              totalVertices += vertCount

              obj.geometry.computeBoundingBox()
              const box = obj.geometry.boundingBox
              if (box) {
                const worldPos = obj.getWorldPosition(new global.THREE.Vector3())
                minX = Math.min(minX, box.min.x + worldPos.x)
                maxX = Math.max(maxX, box.max.x + worldPos.x)
                minY = Math.min(minY, box.min.y + worldPos.y)
                maxY = Math.max(maxY, box.max.y + worldPos.y)
                minZ = Math.min(minZ, box.min.z + worldPos.z)
                maxZ = Math.max(maxZ, box.max.z + worldPos.z)
              }
            }
          }
        }
      })

      const debugInfo = {
        chunkCount,
        sectionsOutstanding: viewer.world?.sectionsOutstanding || 0,
        sceneChildren: viewer.scene.children.length,
        botWorldColumns: Object.keys(this.bot.world.async?.columns || {}).length,
        botWorldLoadedChunks: this.bot.world.getColumns ? this.bot.world.getColumns().length : 'N/A',
        camera: {
          position: { x: camera.position.x.toFixed(1), y: camera.position.y.toFixed(1), z: camera.position.z.toFixed(1) },
          rotation: { x: camera.rotation.x.toFixed(3), y: camera.rotation.y.toFixed(3), z: camera.rotation.z.toFixed(3), order: camera.rotation.order },
          near: camera.near,
          far: camera.far,
          fov: camera.fov
        },
        botLookDirection: {
          yawRad: yaw.toFixed(3),
          pitchRad: pitch.toFixed(3),
          yawDeg: (yaw * 180 / Math.PI).toFixed(1),
          pitchDeg: (pitch * 180 / Math.PI).toFixed(1)
        },
        meshInfo: {
          totalMeshes: meshCount,
          meshesWithVertices,
          totalVertices
        },
        geometryBounds: {
          min: { x: Math.round(minX), y: Math.round(minY), z: Math.round(minZ) },
          max: { x: Math.round(maxX), y: Math.round(maxY), z: Math.round(maxZ) },
          center: { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2), z: Math.round((minZ + maxZ) / 2) }
        },
        loadedChunkSamples: loadedChunkCoords
      }

      // Check if bot moved during async operations
      const currentPos = this.bot.entity.position
      const positionDrift = Math.sqrt(
        Math.pow(currentPos.x - pos.x, 2) +
        Math.pow(currentPos.y - pos.y, 2) +
        Math.pow(currentPos.z - pos.z, 2)
      )
      if (positionDrift > 1) {
        console.log(`[Screenshot WARNING] Bot moved ${positionDrift.toFixed(1)} blocks during screenshot!`)
        debugInfo.warning = `Bot moved ${positionDrift.toFixed(1)} blocks during capture`
      }
      debugInfo.capturedPosition = { x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1) }
      debugInfo.currentPosition = { x: currentPos.x.toFixed(1), y: currentPos.y.toFixed(1), z: currentPos.z.toFixed(1) }

      console.log(`[Screenshot DEBUG] ${JSON.stringify(debugInfo)}`)

      // Update and render
      viewer.camera.position.set(pos.x, pos.y + eyeHeight, pos.z)
      viewer.camera.rotation.set(pitch, yaw, 0, 'ZYX')
      viewer.update()
      renderer.render(viewer.scene, viewer.camera)

      // Get PNG buffer
      const pngBuffer = canvas.toBuffer('image/png')

      // Cleanup renderer
      renderer.dispose()

      // Save screenshot to disk
      const screenshotDir = path.join(process.cwd(), '..', 'state', 'screenshots')
      if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true })
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `screenshot-${timestamp}.png`
      const filepath = path.join(screenshotDir, filename)
      fs.writeFileSync(filepath, pngBuffer)

      // Return image with debug info
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
              yaw: (yaw * 180 / Math.PI).toFixed(1) + '°',
              pitch: (pitch * 180 / Math.PI).toFixed(1) + '°',
              width,
              height,
              view_distance,
              saved_to: filepath,
              debug: debugInfo
            }, null, 2)
          },
          {
            type: 'image',
            data: pngBuffer.toString('base64'),
            mimeType: 'image/png'
          }
        ]
      }
    } catch (err) {
      return error(`Screenshot failed: ${err.message}`)
    }
  }
}
