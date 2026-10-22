// rules-tab.js - Handles the Rules UI in the dashboard

import { sendMessage } from '../../shared/messaging.js';
import { escapeHtml, showToast } from '../../shared/utils.js';
import { openRuleModal } from '../dashboard.js';

const rulesTableBody = document.getElementById('rulesTableBody');
const addRuleBtn = document.getElementById('addRuleBtn');
const importRulesBtn = document.getElementById('importRulesBtn');
const importShareBtn = document.getElementById('importShareBtn');
const exportRulesBtn = document.getElementById('exportRulesBtn');
const importFileInput = document.getElementById('importFileInput');
const filterChips = document.querySelectorAll('.filter-chip');
const ruleSearchInput = document.getElementById('ruleSearchInput');
const bulkActionsBar = document.getElementById('bulkActionsBar');
const bulkEnableBtn = document.getElementById('bulkEnableBtn');
const bulkDisableBtn = document.getElementById('bulkDisableBtn');
const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
const selectAllRules = document.getElementById('selectAllRules');

let allRules = [];
let currentFilter = 'all';

export function initRulesTab() {
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      renderRulesTable();
    });
  });

  importRulesBtn.addEventListener('click', () => importFileInput.click());

  if (importShareBtn) {
    importShareBtn.addEventListener('click', async () => {
      const link = prompt('Paste a Nariya Shareable Link (nariya://import?data=...)');
      if (link && link.startsWith('nariya://import?data=')) {
        try {
          const base64 = link.split('data=')[1];
          const json = atob(base64);
          const rule = JSON.parse(json);
          await sendMessage('IMPORT_RULES', { rules: [rule] });
          await loadRules();
          showToast('Rule imported successfully!', 'success');
        } catch (err) {
          showToast('Failed to parse shareable link.', 'error');
        }
      } else if (link) {
        showToast('Invalid Nariya link format.', 'error');
      }
    });
  }

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rules = JSON.parse(text);
      await sendMessage('IMPORT_RULES', { rules });
      await loadRules();
    } catch (err) {
      showToast('Invalid JSON file', 'error');
    }
    importFileInput.value = '';
  });

  exportRulesBtn.addEventListener('click', async () => {
    const res = await sendMessage('EXPORT_RULES');
    if (!res.ok) return;
    const blob = new Blob([res.data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nariya-rules-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  ruleSearchInput.addEventListener('input', () => {
    renderRulesTable();
  });

  selectAllRules.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    document.querySelectorAll('.rule-row-checkbox').forEach(cb => {
      cb.checked = isChecked;
    });
    updateBulkActionsVisibility();
  });

  bulkEnableBtn.addEventListener('click', async () => {
    const selectedIds = getSelectedRuleIds();
    for (const id of selectedIds) await sendMessage('TOGGLE_RULE', { id, enabled: true });
    await loadRules();
  });

  bulkDisableBtn.addEventListener('click', async () => {
    const selectedIds = getSelectedRuleIds();
    for (const id of selectedIds) await sendMessage('TOGGLE_RULE', { id, enabled: false });
    await loadRules();
  });

  bulkDeleteBtn.addEventListener('click', async () => {
    if (confirm('Delete selected rules?')) {
      const selectedIds = getSelectedRuleIds();
      for (const id of selectedIds) await sendMessage('DELETE_RULE', { id });
      await loadRules();
    }
  });
}

function getSelectedRuleIds() {
  return Array.from(document.querySelectorAll('.rule-row-checkbox:checked')).map(cb => cb.dataset.id);
}

function updateBulkActionsVisibility() {
  const selectedCount = document.querySelectorAll('.rule-row-checkbox:checked').length;
  bulkActionsBar.style.display = selectedCount > 0 ? 'flex' : 'none';
}

export async function loadRules() {
  const res = await sendMessage('GET_ALL_RULES');
  if (res.ok) {
    allRules = res.data || [];
    renderRulesTable();
  }
}

export function getAllRules() {
  return allRules;
}

function renderRulesTable() {
  const searchQuery = (ruleSearchInput.value || '').toLowerCase();
  
  const filtered = (currentFilter === 'all'
    ? allRules
    : allRules.filter(r => r.type === currentFilter)).filter(r => {
      if (!searchQuery) return true;
      const name = (r.config?.name || '').toLowerCase();
      const url = (r.urlFilter || '').toLowerCase();
      return name.includes(searchQuery) || url.includes(searchQuery);
    });

  selectAllRules.checked = false;
  updateBulkActionsVisibility();

  if (filtered.length === 0) {
    rulesTableBody.innerHTML = `
      <tr class="empty-row"><td colspan="6">
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>
          </svg>
          <p>No rules yet. Click "Add Rule" to get started.</p>
        </div>
      </td></tr>`;
    return;
  }

  // Group rules
  const grouped = {};
  for (const rule of filtered) {
    const gName = rule.group || 'Default';
    if (!grouped[gName]) grouped[gName] = [];
    grouped[gName].push(rule);
  }

  let html = '';

  // Render groups
  for (const [groupName, rulesInGroup] of Object.entries(grouped)) {
    // Render Group Header
    html += `
        <tr class="group-header" style="background: var(--bg-tertiary); border-bottom: 2px solid var(--border);">
            <td colspan="6" style="padding: 8px 12px; border-radius: 4px;">
                <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text-primary);">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--bg-tertiary)" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span>${escapeHtml(groupName)}</span>
                    <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; margin-left: auto;">${rulesInGroup.length} rule(s)</span>
                </div>
            </td>
        </tr>`;

    // Render rules inside group
    html += rulesInGroup.map(rule => `
        <tr data-id="${rule.id}">
          <td><input type="checkbox" class="rule-row-checkbox" data-id="${rule.id}"></td>
          <td>
            <label class="toggle-switch">
              <input type="checkbox" class="rule-toggle" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </td>
          <td><span class="rule-type-badge badge-${rule.type}">${rule.type}</span></td>
          <td>${escapeHtml(rule.config?.name || rule.type + ' rule')}</td>
          <td class="rule-url-cell">${escapeHtml(rule.urlFilter || '*')}</td>
          <td>
            <div class="action-btns">
              <button class="btn-sm share-rule" data-id="${rule.id}" title="Share Rule">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              </button>
              <button class="btn-sm duplicate-rule" data-id="${rule.id}" title="Duplicate">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              <button class="btn-sm edit-rule" data-id="${rule.id}" title="Edit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="btn-sm delete delete-rule" data-id="${rule.id}" title="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `).join('');
  }

  rulesTableBody.innerHTML = html;

  // Bind toggle events
  rulesTableBody.querySelectorAll('.rule-toggle').forEach(toggle => {
    toggle.addEventListener('change', async () => {
      await sendMessage('TOGGLE_RULE', { id: toggle.dataset.id, enabled: toggle.checked });
      await loadRules();
    });
  });

  // Bind checkbox events
  rulesTableBody.querySelectorAll('.rule-row-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const allChecked = Array.from(rulesTableBody.querySelectorAll('.rule-row-checkbox')).every(c => c.checked);
      selectAllRules.checked = allChecked && rulesTableBody.querySelectorAll('.rule-row-checkbox').length > 0;
      updateBulkActionsVisibility();
    });
  });

  // Bind share events
  rulesTableBody.querySelectorAll('.share-rule').forEach(btn => {
    btn.addEventListener('click', () => {
      const rule = allRules.find(r => r.id === btn.dataset.id);
      if (rule) {
        const exportRule = JSON.parse(JSON.stringify(rule));
        delete exportRule.id; // Allow new ID generation on import
        const base64 = btoa(JSON.stringify(exportRule));
        const snippet = `nariya://import?data=${base64}`;
        navigator.clipboard.writeText(snippet).then(() => {
          showToast('Shareable link copied to clipboard!\n\n' + snippet, 'success');
        });
      }
    });
  });

  // Bind duplicate events
  rulesTableBody.querySelectorAll('.duplicate-rule').forEach(btn => {
    btn.addEventListener('click', () => {
      const rule = allRules.find(r => r.id === btn.dataset.id);
      if (rule) {
        const clonedRule = JSON.parse(JSON.stringify(rule));
        delete clonedRule.id;
        if (clonedRule.config && clonedRule.config.name) {
          clonedRule.config.name += ' (Copy)';
        }
        openRuleModal(clonedRule);
      }
    });
  });

  // Bind edit events
  rulesTableBody.querySelectorAll('.edit-rule').forEach(btn => {
    btn.addEventListener('click', () => {
      const rule = allRules.find(r => r.id === btn.dataset.id);
      if (rule) openRuleModal(rule);
    });
  });

  // Bind delete events
  rulesTableBody.querySelectorAll('.delete-rule').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Delete this rule?')) {
        await sendMessage('DELETE_RULE', { id: btn.dataset.id });
        await loadRules();
      }
    });
  });
}
