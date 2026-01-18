#!/usr/bin/env node
/**
 * Microsoft authentication for Minecraft using prismarine-auth.
 *
 * Usage:
 *   node auth.js login <email>           - Authenticate (device code flow)
 *   node auth.js status <email>          - Check token status
 *   node auth.js export <email> <file>   - Export tokens to file
 *   node auth.js import <file>           - Import tokens from file
 */

import prismarineAuth from 'prismarine-auth'
const { Authflow, Titles } = prismarineAuth
import fs from 'fs'
import path from 'path'

const CACHE_DIR = process.env.MC_AUTH_CACHE || path.join(process.env.HOME, '.minecraft', 'nmp-cache')

async function login(email) {
  console.log(`\nAuthenticating: ${email}`)
  console.log(`Token cache: ${CACHE_DIR}\n`)

  const flow = new Authflow(email, CACHE_DIR, {
    flow: 'sisu',  // Works better for some accounts
    authTitle: Titles.MinecraftJava,
    deviceType: 'Win32'
  }, (code) => {
    console.log('='.repeat(50))
    console.log('MICROSOFT LOGIN')
    console.log('='.repeat(50))
    console.log(`\n  1. Open: ${code.verification_uri}`)
    console.log(`  2. Enter: ${code.user_code}`)
    console.log(`\n  Code expires in ${Math.floor(code.expires_in / 60)} minutes`)
    console.log('='.repeat(50))
    console.log('\nWaiting for browser login...\n')
  })

  try {
    // Get Minecraft token (this triggers the full auth chain)
    const mcToken = await flow.getMinecraftJavaToken()

    console.log('\n' + '='.repeat(50))
    console.log('SUCCESS')
    console.log('='.repeat(50))
    console.log(`\n  Username: ${mcToken.profile.name}`)
    console.log(`  UUID: ${mcToken.profile.id}`)
    console.log(`\n  Tokens cached in: ${CACHE_DIR}`)
    console.log('  Copy this directory to headless servers.\n')

    return mcToken
  } catch (err) {
    console.error('\nAuth failed:', err.message)
    process.exit(1)
  }
}

async function status(email) {
  console.log(`\nChecking token status for: ${email}`)
  console.log(`Cache: ${CACHE_DIR}\n`)

  const flow = new Authflow(email, CACHE_DIR, {
    flow: 'sisu',
    authTitle: Titles.MinecraftJava
  })

  // Check cache files
  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))
  console.log(`Cache files: ${cacheFiles.length}`)
  cacheFiles.forEach(f => {
    const content = fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')
    const size = content.length
    console.log(`  ${f}: ${size} bytes`)
  })

  try {
    // Try to get token without triggering new auth
    const mcToken = await flow.getMinecraftJavaToken({ fetchProfile: true })
    console.log('\n  Status: VALID')
    console.log(`  Username: ${mcToken.profile.name}`)
    console.log(`  UUID: ${mcToken.profile.id}`)
  } catch (err) {
    console.log('\n  Status: EXPIRED or INVALID')
    console.log(`  Error: ${err.message}`)
    console.log('  Run "node auth.js login <email>" to re-authenticate')
  }
}

async function exportTokens(email, outputFile) {
  console.log(`\nExporting tokens for: ${email}`)

  const files = {}
  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))

  for (const f of cacheFiles) {
    files[f] = fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')
  }

  const bundle = {
    email,
    exported: new Date().toISOString(),
    files
  }

  fs.writeFileSync(outputFile, JSON.stringify(bundle, null, 2))
  console.log(`Exported ${Object.keys(files).length} files to: ${outputFile}`)
  console.log('\nTransfer this file to your server and run:')
  console.log(`  node auth.js import ${outputFile}`)
}

async function importTokens(inputFile) {
  console.log(`\nImporting tokens from: ${inputFile}`)

  const bundle = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
  console.log(`  Email: ${bundle.email}`)
  console.log(`  Exported: ${bundle.exported}`)

  // Ensure cache dir exists
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  for (const [filename, content] of Object.entries(bundle.files)) {
    const targetPath = path.join(CACHE_DIR, filename)
    fs.writeFileSync(targetPath, content)
    console.log(`  Wrote: ${filename}`)
  }

  console.log(`\nTokens imported to: ${CACHE_DIR}`)
  console.log('Run "node auth.js status <email>" to verify')
}

// CLI
const [,, command, ...args] = process.argv

switch (command) {
  case 'login':
    if (!args[0]) {
      console.log('Usage: node auth.js login <email>')
      process.exit(1)
    }
    await login(args[0])
    break

  case 'status':
    if (!args[0]) {
      console.log('Usage: node auth.js status <email>')
      process.exit(1)
    }
    await status(args[0])
    break

  case 'export':
    if (!args[0] || !args[1]) {
      console.log('Usage: node auth.js export <email> <output-file>')
      process.exit(1)
    }
    await exportTokens(args[0], args[1])
    break

  case 'import':
    if (!args[0]) {
      console.log('Usage: node auth.js import <file>')
      process.exit(1)
    }
    await importTokens(args[0])
    break

  default:
    console.log(`
Minecraft Auth Helper (prismarine-auth)

Commands:
  login <email>              Authenticate via device code flow
  status <email>             Check if tokens are valid
  export <email> <file>      Export tokens to portable file
  import <file>              Import tokens from file

Environment:
  MC_AUTH_CACHE              Token cache directory (default: ~/.minecraft/nmp-cache)

Examples:
  node auth.js login haksnbot@hotmail.com
  node auth.js status haksnbot@hotmail.com
  node auth.js export haksnbot@hotmail.com tokens.json
  scp tokens.json server:~/
  ssh server "node auth.js import tokens.json"
`)
}
