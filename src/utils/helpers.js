/**
 * Helper utilities for MCP responses and common operations
 */

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
