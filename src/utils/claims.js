/**
 * GriefPrevention claim detection utilities
 */

// Helper to check GriefPrevention claim status at a location
export async function checkClaimStatus(bot) {
  return new Promise((resolve) => {
    const claimInfo = {
      claimed: false,
      owner: null,
      builders: [],
      containers: [],
      accessors: [],
      managers: [],
      raw_messages: []
    }

    // Collect chat messages for a short window after running /trustlist
    const onMessage = (jsonMsg) => {
      const text = jsonMsg.toString()
      claimInfo.raw_messages.push(text)

      // Parse GriefPrevention /trustlist output
      // Format: "Claim owner: PlayerName" or just shows trust levels
      if (text.includes('No claim exists') || text.includes('Wilderness')) {
        claimInfo.claimed = false
      } else if (text.includes('owner:') || text.includes('Owner:')) {
        claimInfo.claimed = true
        const match = text.match(/[Oo]wner:\s*(\S+)/)
        if (match) claimInfo.owner = match[1]
      } else if (text.includes('Managers:')) {
        claimInfo.claimed = true
        const match = text.match(/Managers:\s*(.+)/)
        if (match) claimInfo.managers = match[1].split(',').map(s => s.trim()).filter(s => s)
      } else if (text.includes('Builders:')) {
        claimInfo.claimed = true
        const match = text.match(/Builders:\s*(.+)/)
        if (match) claimInfo.builders = match[1].split(',').map(s => s.trim()).filter(s => s)
      } else if (text.includes('Containers:')) {
        claimInfo.claimed = true
        const match = text.match(/Containers:\s*(.+)/)
        if (match) claimInfo.containers = match[1].split(',').map(s => s.trim()).filter(s => s)
      } else if (text.includes('Accessors:')) {
        claimInfo.claimed = true
        const match = text.match(/Accessors:\s*(.+)/)
        if (match) claimInfo.accessors = match[1].split(',').map(s => s.trim()).filter(s => s)
      } else if (text.includes("That command is not recognized")) {
        // Command doesn't exist, just note it
        claimInfo.command_error = true
      }
    }

    bot.on('message', onMessage)

    // Run trustlist command - GriefPrevention standard command
    bot.chat(`/trustlist`)

    // Wait for responses then resolve
    setTimeout(() => {
      bot.removeListener('message', onMessage)
      resolve(claimInfo)
    }, 1500)
  })
}
