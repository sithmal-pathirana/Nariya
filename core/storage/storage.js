/**
 * Nariya — Storage Layer
 * Thin abstraction over chrome.storage.local for rule persistence.
 */

import { sanitizeRule, sanitizeImportedRules } from './sanitizer.js';

const STORAGE_KEY = 'nariya_rules';
const SETTINGS_KEY = 'nariya_settings';

/**
 * Default settings
 */
const DEFAULT_SETTINGS = {
  globalEnabled: true,
  interceptorAutoForward: false,
  maxRepeaterHistory: 500,
  theme: 'dark',
  allowCorsBypass: true
};

/**
 * Generate a unique rule ID
 */
function generateId() {
  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Get all rules from storage
 * @returns {Promise<Array>}
 */
export async function getAllRules() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

/**
 * Save a single rule (create or update)
 * @param {Object} rule
 * @returns {Promise<Object>} The saved rule with ID
 */
export async function saveRule(rawRule) {
  const rules = await getAllRules();
  const rule = sanitizeRule(rawRule);

  if (rule.id) {
    // Update existing
    const idx = rules.findIndex(r => r.id === rule.id);
    if (idx !== -1) {
      rules[idx] = { ...rules[idx], ...rule, updatedAt: Date.now() };
    } else {
      rules.push({ ...rule, createdAt: Date.now(), updatedAt: Date.now() });
    }
  } else {
    // Create new
    rule.id = generateId();
    rule.createdAt = Date.now();
    rule.updatedAt = Date.now();
    rule.enabled = rule.enabled !== undefined ? rule.enabled : true;
    rules.push(rule);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: rules });
  return rule;
}

/**
 * Delete a rule by ID
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteRule(id) {
  const rules = await getAllRules();
  const filtered = rules.filter(r => r.id !== id);

  if (filtered.length === rules.length) return false;

  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
  return true;
}

/**
 * Toggle a rule's enabled state
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Promise<Object|null>}
 */
export async function toggleRule(id, enabled) {
  const rules = await getAllRules();
  const rule = rules.find(r => r.id === id);

  if (!rule) return null;

  rule.enabled = enabled;
  rule.updatedAt = Date.now();

  await chrome.storage.local.set({ [STORAGE_KEY]: rules });
  return rule;
}

/**
 * Get all rules filtered by type
 * @param {string} type - redirect | header | mock | delay | script
 * @returns {Promise<Array>}
 */
export async function getRulesByType(type) {
  const rules = await getAllRules();
  return rules.filter(r => r.type === type);
}

/**
 * Get enabled rules only
 * @returns {Promise<Array>}
 */
export async function getEnabledRules() {
  const rules = await getAllRules();
  return rules.filter(r => r.enabled);
}

/**
 * Import rules from JSON array (merge)
 * @param {Array} importedRules
 * @returns {Promise<number>} Number of rules imported
 */
export async function importRules(importedRules) {
  const existing = await getAllRules();
  const existingIds = new Set(existing.map(r => r.id));

  const sanitizedRules = sanitizeImportedRules(importedRules);

  let count = 0;
  for (const rule of sanitizedRules) {
    if (!existingIds.has(rule.id)) {
      rule.id = rule.id || generateId();
      rule.createdAt = rule.createdAt || Date.now();
      rule.updatedAt = Date.now();
      existing.push(rule);
      count++;
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
  return count;
}

/**
 * Export all rules as JSON
 * @returns {Promise<string>}
 */
export async function exportRules() {
  const rules = await getAllRules();
  return JSON.stringify(rules, null, 2);
}

/**
 * Clear all rules
 * @returns {Promise<void>}
 */
export async function clearAllRules() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}

/**
 * Get extension settings
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

/**
 * Update extension settings
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateSettings(updates) {
  const current = await getSettings();
  const merged = { ...current, ...updates };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}
