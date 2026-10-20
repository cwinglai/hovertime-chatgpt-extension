const CONFIG = {
  defaults: {
    color: '#6b7280',
    timeFormat: '12h',
    dateFormat: 'letters',
    showDate: true
  },
  storageKeys: {
    timestamps: 'hovertime_timestamps',
    settings: 'hovertime_settings'
  }
};

let currentSettings = { ...CONFIG.defaults };
let messageTimestamps = {};  // keyed by our own content-hash id (see getMessageId/hashText) — NOT a ChatGPT-provided id, which has broken twice
let currentConversationId; // undefined = not yet initialized (distinct from a real "no conversation" null)
let initialScanDone = false;
let preExistingMessageIds = new Set();

// ─── Storage (localStorage — works in MAIN world) ──────────────────────────

function loadSettings() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKeys.settings);
    if (raw) currentSettings = { ...CONFIG.defaults, ...JSON.parse(raw) };
  } catch (e) {}
  return currentSettings;
}

function saveSettings(settings) {
  currentSettings = { ...currentSettings, ...settings };
  try {
    localStorage.setItem(CONFIG.storageKeys.settings, JSON.stringify(currentSettings));
  } catch (e) {}
}

function loadTimestamps() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKeys.timestamps);
    if (raw) messageTimestamps = JSON.parse(raw);
  } catch (e) {}
  return messageTimestamps;
}

function saveTimestamps() {
  try {
    localStorage.setItem(CONFIG.storageKeys.timestamps, JSON.stringify(messageTimestamps));
  } catch (e) {}
}

// ─── Conversation data capture ─────────────────────────────────────────────
// Passively watches fetch calls ChatGPT's own app happens to make (e.g.
// navigating between conversations via the sidebar) for real create_time
// data. The harder case — a hard refresh landing directly on an existing
// conversation, where no such fetch may ever fire — is covered separately
// by extractLiveTimestamp()'s React-state walk, which needs no network call.

function ingestConversationMapping(mapping) {
  if (!mapping) return false;
  let changed = false;
  Object.values(mapping).forEach(node => {
    const msg = node?.message;
    const text = msg?.content?.parts?.join('')?.trim().substring(0, 200);
    if (text && msg?.create_time) {
      messageTimestamps[`msg_${hashText(text)}`] = new Date(msg.create_time * 1000).toISOString();
      changed = true;
    }
  });
  if (changed) saveTimestamps();
  return changed;
}

(function setupFetchInterceptor() {
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (url.includes('conversation') &&
          !url.includes('gen_title') &&
          !url.includes('share')) {
        const clone = response.clone();
        clone.json().then(data => {
          if (ingestConversationMapping(data?.mapping)) {
            setTimeout(addTimestamps, 200);
          }
        }).catch(() => {});
      }
    } catch (e) {}
    return response;
  };
})();

// ─── Formatting ────────────────────────────────────────────────────────────

function formatTimestamp(date, settings) {
  const hours24 = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');

  let timeStr = '';
  if (settings.timeFormat === '12h') {
    const hours12 = hours24 % 12 || 12;
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    timeStr = `${hours12}:${minutes}:${seconds} ${ampm}`;
  } else {
    timeStr = `${hours24.toString().padStart(2, '0')}:${minutes}:${seconds}`;
  }

  if (settings.showDate) {
    let dateStr = '';
    if (settings.dateFormat === 'letters') {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      dateStr = `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    } else {
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      dateStr = `${year}/${month}/${day}`;
    }
    return `${dateStr} - ${timeStr}`;
  }
  return timeStr;
}

// ─── React state extraction ────────────────────────────────────────────────
// Runs only at hover time, only when the fetch interceptor/self-fetch never
// caught this message's data. Walks React's own internal fiber tree to read
// the conversation mapping ChatGPT's own UI already holds in component state
// — this needs no network request (and so no auth token), and works whether
// the conversation arrived via a fetch or was server-rendered into the page.
// Adapted from github.com/Hangzhi/chatgpt-timestamp-extension.

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  let timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(timestamp)) {
    timestamp = Date.parse(value) / 1000;
  } else if (Math.abs(timestamp) >= 1e12) {
    timestamp /= 1000;
  }
  return Number.isFinite(timestamp) ? timestamp : null;
}

function ownValue(object, key) {
  if (!object || typeof object !== 'object' || !Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  return object[key];
}

// Finds the DOM node's React fiber and walks up to the committed (actually
// rendered) version of the tree — a fiber reference by itself can be a stale
// work-in-progress node, which would yield props that were never painted.
function getCommittedFiber(domNode) {
  const fiberKey = Object.keys(domNode).find(key => key.startsWith('__reactFiber$'));
  if (!fiberKey) return null;

  const originalPath = [];
  const seen = new Set();
  let fiber = ownValue(domNode, fiberKey);
  let root = null;
  for (let depth = 0; fiber && depth < 400; depth++) {
    if (seen.has(fiber)) return null;
    seen.add(fiber);
    originalPath.push(fiber);
    if (ownValue(fiber, 'tag') === 3) {
      const rootState = ownValue(fiber, 'stateNode');
      const current = ownValue(rootState, 'current');
      if (current === fiber || current === ownValue(fiber, 'alternate')) {
        root = { fiber, state: rootState, current };
        break;
      }
    }
    fiber = ownValue(fiber, 'return');
  }
  if (!root) return null;

  const committedPath = [root.current];
  let committedParent = root.current;
  let work = 0;
  for (let pathIndex = originalPath.length - 2; pathIndex >= 0; pathIndex--) {
    const wanted = originalPath[pathIndex];
    const alternate = ownValue(wanted, 'alternate');
    const siblingSeen = new Set();
    const matches = [];
    let child = ownValue(committedParent, 'child');
    for (let siblings = 0; child && siblings < 1024; siblings++) {
      if (++work > 4096 || siblingSeen.has(child)) return null;
      siblingSeen.add(child);
      if (child === wanted || child === alternate) matches.push(child);
      child = ownValue(child, 'sibling');
    }
    if (child || matches.length !== 1) return null;
    committedParent = matches[0];
    committedPath.push(committedParent);
  }

  if (ownValue(root.state, 'current') !== root.current) return null;
  const views = committedPath.map(committedFiber => ({
    memoizedProps: ownValue(committedFiber, 'memoizedProps'),
    memoizedState: ownValue(committedFiber, 'memoizedState'),
    updateQueue: ownValue(committedFiber, 'updateQueue'),
    return: null
  }));
  for (let i = 1; i < views.length; i++) views[i].return = views[i - 1];
  return views[views.length - 1];
}

function getTurnEntry(committedFiber, conversationId) {
  let fiber = committedFiber;
  const seen = new Set();
  for (let depth = 0; fiber && depth < 32; depth++) {
    if (seen.has(fiber)) return null;
    seen.add(fiber);
    const props = fiber.memoizedProps;
    const entry = ownValue(props, 'entry');
    const turn = ownValue(entry, 'turn');
    const items = ownValue(turn, 'items');
    if (Array.isArray(items) && ownValue(entry, 'conversationId') === conversationId) {
      const entryId = ownValue(entry, 'id');
      if (typeof entryId !== 'string' || !entryId) return null;
      return { entry, turn, items };
    }
    fiber = fiber.return;
  }
  return null;
}

function isSnapshotCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.prototype.hasOwnProperty.call(value, 'renderedConversation') &&
    Object.prototype.hasOwnProperty.call(value, 'renderedTurns');
}

// Hunts through this component subtree's hook/memo state for a snapshot
// object holding the full conversation mapping (the same {id: {message}}
// shape the backend API returns) that ChatGPT's own UI reads from to render.
function findLiveSnapshot(committedFiber, turnInfo) {
  const candidates = [];
  let remaining = 2048;
  const addCandidate = value => { if (isSnapshotCandidate(value)) candidates.push(value); };
  const inspectMemoCache = memoData => {
    if (!Array.isArray(memoData) || memoData.length > 32) return true;
    for (const row of memoData) {
      if (!Array.isArray(row) || row.length > 1024) continue;
      for (const value of row) {
        if (--remaining < 0) return false;
        addCandidate(value);
      }
    }
    return true;
  };

  const seenFibers = new Set();
  let owner = committedFiber;
  owners: for (let depth = 0; owner && depth < 400; depth++, owner = owner.return) {
    if (seenFibers.has(owner)) return null;
    seenFibers.add(owner);
    if (ownValue(owner.memoizedProps, 'conversationId') !== turnInfo.entry.conversationId) continue;

    let hook = owner.memoizedState;
    const seenHooks = new Set();
    while (hook && remaining > 0) {
      if (seenHooks.has(hook)) return null;
      seenHooks.add(hook);
      remaining--;
      const state = ownValue(hook, 'memoizedState');
      addCandidate(state);
      if (Array.isArray(state)) addCandidate(state[0]);
      hook = ownValue(hook, 'next');
    }
    if (hook || remaining <= 0) break owners;

    const updateQueue = owner.updateQueue;
    const memoCache = ownValue(updateQueue, 'memoCache');
    const memoData = ownValue(memoCache, 'data');
    if (!inspectMemoCache(memoData)) break owners;
  }

  const valid = [];
  for (const snapshot of candidates) {
    const renderedConversation = ownValue(snapshot, 'renderedConversation');
    const renderedTurns = ownValue(snapshot, 'renderedTurns');
    const mapping = ownValue(renderedConversation, 'mapping');
    if (!mapping || typeof mapping !== 'object' || !Array.isArray(renderedTurns)) continue;

    const matchingTurns = renderedTurns.filter(turn =>
      ownValue(turn, 'id') === ownValue(turnInfo.entry, 'id') &&
      ownValue(turn, 'turn') === turnInfo.turn
    );
    if (matchingTurns.length !== 1) continue;

    const userNode = ownValue(mapping, turnInfo.userId);
    const userMessage = ownValue(userNode, 'message');
    if (ownValue(userNode, 'id') !== turnInfo.userId ||
        ownValue(userMessage, 'id') !== turnInfo.userId ||
        ownValue(ownValue(userMessage, 'author'), 'role') !== 'user') continue;
    valid.push({ snapshot, mapping, renderedConversation });
  }
  if (!valid.length) return null;

  const firstMapping = valid[0].mapping;
  if (valid.some(candidate => candidate.mapping !== firstMapping)) return null;
  const currentNodeValues = valid
    .map(candidate => ({ present: Object.prototype.hasOwnProperty.call(candidate.renderedConversation, 'current_node'), value: ownValue(candidate.renderedConversation, 'current_node') }))
    .filter(candidate => candidate.present);
  if (currentNodeValues.some(candidate => !Object.is(candidate.value, currentNodeValues[0].value))) return null;
  return { mapping: firstMapping };
}

function getSemanticUnit(turn, role) {
  return turn.querySelector(`[data-chatgpt-search-unit-key$=":${role}"][data-chatgpt-search-message-ids]`);
}

function getUnitMessageIds(unit) {
  const value = unit?.getAttribute('data-chatgpt-search-message-ids') || '';
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}

function getTypedItemIds(item, role) {
  const keys = role === 'user' ? ['messageId', 'serverMessageId'] : ['messageId', 'latestMessageId'];
  return [...new Set(keys.map(key => ownValue(item, key)).filter(id => typeof id === 'string' && id))];
}

function getMessageTimestamp(mapping, id, role) {
  const node = ownValue(mapping, id);
  const message = ownValue(node, 'message');
  if (ownValue(node, 'id') !== id || ownValue(message, 'id') !== id ||
      ownValue(ownValue(message, 'author'), 'role') !== role) return null;
  return normalizeTimestamp(ownValue(message, 'create_time'));
}

function resolveTurnTimestamp(unit, turnInfo, mapping, role) {
  if (!unit) return null;
  const unitIds = getUnitMessageIds(unit);
  if (!unitIds.length) return null;

  const typedItems = role === 'user'
    ? [turnInfo.userItem]
    : turnInfo.items.filter(item => ownValue(item, 'type') === 'assistant-message');
  const selectionId = role === 'assistant'
    ? unit.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id')
    : null;
  const usableSelectionId = selectionId && unitIds.includes(selectionId) ? selectionId : null;

  const candidates = [];
  for (const item of typedItems) {
    const matchingIds = getTypedItemIds(item, role).filter(id => unitIds.includes(id));
    for (const id of matchingIds) {
      candidates.push({ id, finalAnswer: ownValue(item, 'phase') === 'final_answer', selected: id === usableSelectionId });
    }
  }
  if (!candidates.length) return null;

  const resolved = candidates
    .map(candidate => ({ ...candidate, timestamp: getMessageTimestamp(mapping, candidate.id, role) }))
    .filter(candidate => candidate.timestamp != null);
  if (!resolved.length) return null;
  const finalAnswers = resolved.filter(candidate => candidate.finalAnswer);
  const preferred = role === 'assistant' && finalAnswers.length ? finalAnswers : resolved;
  const selected = preferred.filter(candidate => candidate.selected);
  const chosen = selected.length ? selected : preferred;
  const ids = [...new Set(chosen.map(candidate => candidate.id))];
  return ids.length === 1 ? chosen[0].timestamp : null;
}

// Only resolves the user-message timestamp — HoverTime only displays on
// [data-user-message-bubble="true"], so there's no need for the assistant side.
function getUserTurnTimestamp(turn, conversationId) {
  const committedFiber = getCommittedFiber(turn);
  if (!committedFiber) return null;

  const turnInfo = getTurnEntry(committedFiber, conversationId);
  if (!turnInfo) return null;

  const userItems = turnInfo.items.filter(item => ownValue(item, 'type') === 'user-message');
  if (userItems.length !== 1) return null;
  turnInfo.userItem = userItems[0];
  turnInfo.userId = ownValue(turnInfo.userItem, 'messageId') || ownValue(turnInfo.userItem, 'serverMessageId');
  if (typeof turnInfo.userId !== 'string' || !turnInfo.userId) return null;

  const liveMapping = findLiveSnapshot(committedFiber, turnInfo);
  if (!liveMapping) return null;

  return resolveTurnTimestamp(getSemanticUnit(turn, 'user'), turnInfo, liveMapping.mapping, 'user');
}

function extractLiveTimestamp(element) {
  const timeEl = element.querySelector('time[datetime]') ||
    element.closest('[data-testid*="conversation-turn"]')?.querySelector('time[datetime]');
  if (timeEl?.getAttribute('datetime')) return timeEl.getAttribute('datetime');

  try {
    const turn = element.closest('[data-turn-key]') || element;
    const conversationId = getCurrentConversationId();
    const ts = conversationId ? getUserTurnTimestamp(turn, conversationId) : null;
    if (ts != null) return new Date(ts * 1000).toISOString();
  } catch (e) {}

  // Fall back to a shallow prop guess in case the turn-based extraction
  // above doesn't apply to this particular DOM shape.
  try {
    const reactKey = Object.keys(element).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
    if (!reactKey) return null;
    let fiber = element[reactKey];
    for (let depth = 0; depth < 8 && fiber; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      const createTime = props?.message?.create_time ?? props?.messages?.[0]?.create_time;
      if (createTime) return new Date(createTime * 1000).toISOString();
    }
  } catch (e) {}
  return null;
}

// ─── Timestamp display ─────────────────────────────────────────────────────

function attachTimestampDisplay(messageElement, messageId) {
  if (messageElement._hoverTimeListeners) {
    messageElement.removeEventListener('mouseenter', messageElement._hoverTimeListeners.show);
    messageElement.removeEventListener('mouseleave', messageElement._hoverTimeListeners.hide);
  }

  let timestampLabel = null;

  const showTimestamp = () => {
    if (timestampLabel) return;
    let timestamp = messageTimestamps[messageId];
    if (!timestamp) {
      timestamp = extractLiveTimestamp(messageElement);
      if (timestamp) {
        messageTimestamps[messageId] = timestamp;
        saveTimestamps();
      }
    }
    if (!timestamp) return;

    const date = new Date(timestamp);
    const formattedTime = formatTimestamp(date, currentSettings);

    timestampLabel = document.createElement('div');
    timestampLabel.className = 'chatgpt-timestamp-label';
    timestampLabel.innerHTML = `<span class="timestamp-text">${formattedTime}</span>`;
    timestampLabel.style.color = currentSettings.color;
    timestampLabel.style.position = 'absolute';
    timestampLabel.style.top = '-18px';
    timestampLabel.style.right = '0px';

    messageElement.style.position = 'relative';
    messageElement.appendChild(timestampLabel);
    setTimeout(() => timestampLabel.classList.add('visible'), 0);
  };

  const hideTimestamp = () => {
    if (timestampLabel) {
      timestampLabel.classList.remove('visible');
      setTimeout(() => {
        if (timestampLabel && timestampLabel.parentNode) {
          timestampLabel.parentNode.removeChild(timestampLabel);
        }
        timestampLabel = null;
      }, 200);
    }
  };

  messageElement._hoverTimeListeners = { show: showTimestamp, hide: hideTimestamp };
  messageElement.addEventListener('mouseenter', showTimestamp);
  messageElement.addEventListener('mouseleave', hideTimestamp);
}

// ChatGPT has twice changed/removed the id it exposes on message elements
// (data-message-id, then an unreliable search-indexing attribute that isn't
// present until some time after a message renders). Instead of trusting any
// ChatGPT-provided identifier, derive our own stable key from the message's
// own rendered text — the fetch interceptor above hashes the same text from
// the API response, so the two sides naturally join without needing any of
// ChatGPT's internal ids.
function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function getMessageId(div) {
  const text = div.textContent.trim().substring(0, 200);
  return text ? `msg_${hashText(text)}` : null;
}

function addTimestamps() {
  document.querySelectorAll('[data-user-message-bubble="true"]').forEach(div => {
    if (div.dataset.timestampAdded) return;
    const messageId = getMessageId(div);
    if (!messageId) return;

    // Only stamp with current time if it's a brand-new message (not pre-existing).
    // Pre-existing messages with no captured data yet still get a listener attached —
    // extractLiveTimestamp() gets a shot at finding the data when the user actually hovers.
    if (!messageTimestamps[messageId] && initialScanDone && !preExistingMessageIds.has(messageId)) {
      messageTimestamps[messageId] = new Date().toISOString();
      saveTimestamps();
    }

    attachTimestampDisplay(div, messageId);
    div.dataset.timestampAdded = 'true';
  });
}

// ─── Conversation loading ──────────────────────────────────────────────────

function getCurrentConversationId() {
  const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/);
  return match ? match[1] : null;
}

function resetForConversation() {
  document.querySelectorAll('.chatgpt-timestamp-label').forEach(el => el.remove());
  document.querySelectorAll('[data-user-message-bubble="true"]').forEach(div => {
    if (div._hoverTimeListeners) {
      div.removeEventListener('mouseenter', div._hoverTimeListeners.show);
      div.removeEventListener('mouseleave', div._hoverTimeListeners.hide);
      delete div._hoverTimeListeners;
    }
    delete div.dataset.timestampAdded;
  });

  // Snapshot which messages currently exist so we don't wrongly stamp them with Date.now()
  preExistingMessageIds = new Set(
    Array.from(document.querySelectorAll('[data-user-message-bubble="true"]'))
      .map(getMessageId).filter(Boolean)
  );

  initialScanDone = true;
  addTimestamps();
}

async function checkConversationChange() {
  const newId = getCurrentConversationId();
  if (newId !== currentConversationId) {
    currentConversationId = newId;
    resetForConversation();
  }
}

// ─── MutationObserver ──────────────────────────────────────────────────────

let observerTimeout;
const observer = new MutationObserver(() => {
  clearTimeout(observerTimeout);
  observerTimeout = setTimeout(() => {
    checkConversationChange();
    if (initialScanDone) addTimestamps();
  }, 500);
});

// ─── Settings UI ───────────────────────────────────────────────────────────

function setupEventListeners() {
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('chatgpt-timestamp-settings-panel');
    const btn = document.getElementById('chatgpt-timestamp-settings-btn');
    if (!panel || panel.style.display === 'none') return;
    if (!panel.contains(e.target) && !btn.contains(e.target)) {
      closeSettingsPanel();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('chatgpt-timestamp-settings-panel');
      if (panel && panel.style.display !== 'none') closeSettingsPanel();
    }
  });
}

function createSettingsButton() {
  const button = document.createElement('button');
  button.id = 'chatgpt-timestamp-settings-btn';
  button.className = 'chatgpt-timestamp-settings-btn';
  button.innerHTML = `
    <div style="position: relative; display: flex; align-items: center; justify-content: center;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; top: -4px; right: -4px;">
        <circle cx="12" cy="12" r="9" stroke-width="2"></circle>
        <polyline points="12 7 12 12 15 15" stroke-width="2.5"></polyline>
      </svg>
    </div>
  `;
  button.title = 'HoverTime Extension Settings';
  button.addEventListener('click', toggleSettingsPanel);
  document.body.appendChild(button);
  updateButtonIconColor(button);
}

function updateButtonIconColor(button) {
  const isDarkMode = document.documentElement.classList.contains('dark');
  button.querySelectorAll('svg').forEach(svg => {
    svg.setAttribute('stroke', isDarkMode ? 'white' : 'black');
  });
}

function createSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'chatgpt-timestamp-settings-panel';
  panel.className = 'chatgpt-timestamp-settings-panel';
  panel.style.display = 'none';

  panel.innerHTML = `
    <div class="settings-header">
      <button class="close-btn" id="close-settings"></button>
      <h3>HoverTime Settings</h3>
    </div>
    <div class="settings-body">
      <div class="setting-group">
        <div class="setting-row">
          <svg class="section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="10" r="4"></circle><circle cx="8" cy="14" r="4"></circle><circle cx="16" cy="14" r="4"></circle>
          </svg>
          <div class="section-divider"></div>
          <div class="color-options">
            <button class="color-btn" data-color="#6b7280" style="background-color: #6b7280;"></button>
            <button class="color-btn" data-color="#374151" style="background-color: #374151;"></button>
            <button class="color-btn" data-color="#c4a484" style="background-color: #c4a484;"></button>
            <button class="color-btn" data-color="#3b82f6" style="background-color: #3b82f6;"></button>
            <button class="color-btn" data-color="#059669" style="background-color: #059669;"></button>
          </div>
        </div>
      </div>
      <div class="setting-group">
        <div class="setting-row">
          <svg class="section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <div class="section-divider"></div>
          <div class="time-format-buttons">
            <button class="time-format-btn" data-format="12h">12h</button>
            <button class="time-format-btn" data-format="24h">24h</button>
          </div>
        </div>
      </div>
      <div class="setting-group">
        <div class="setting-row">
          <svg class="section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
          <div class="section-divider"></div>
          <div class="date-format-buttons">
            <button class="date-format-btn" data-format="numeric">Numeric</button>
            <button class="date-format-btn" data-format="letters">Letters</button>
          </div>
        </div>
      </div>
      <div class="setting-group">
        <div class="setting-row">
          <svg class="section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>
          </svg>
          <div class="section-divider"></div>
          <div class="show-date-buttons">
            <button class="show-date-btn" data-show="true">Show Date</button>
            <button class="show-date-btn" data-show="false">No Date</button>
          </div>
        </div>
      </div>
      <div class="setting-group">
        <div class="preview-box" id="timestamp-preview">
          <span class="timestamp-text" id="preview-text"></span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  attachSettingsPanelListeners();
  updateSettingsUI();

  new MutationObserver(() => {
    const button = document.getElementById('chatgpt-timestamp-settings-btn');
    if (button) updateButtonIconColor(button);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

function toggleSettingsPanel() {
  const panel = document.getElementById('chatgpt-timestamp-settings-panel');
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    panel.classList.remove('closing');
  } else {
    closeSettingsPanel();
  }
}

function closeSettingsPanel() {
  const panel = document.getElementById('chatgpt-timestamp-settings-panel');
  panel.classList.add('closing');
  setTimeout(() => {
    panel.style.display = 'none';
    panel.classList.remove('closing');
  }, 200);
}

function refreshAllTimestamps() {
  document.querySelectorAll('.chatgpt-timestamp-label').forEach(label => label.remove());
  document.querySelectorAll('[data-user-message-bubble="true"]').forEach(div => {
    if (div._hoverTimeListeners) {
      div.removeEventListener('mouseenter', div._hoverTimeListeners.show);
      div.removeEventListener('mouseleave', div._hoverTimeListeners.hide);
      delete div._hoverTimeListeners;
    }
    delete div.dataset.timestampAdded;
  });
  addTimestamps();
}

function attachSettingsPanelListeners() {
  document.getElementById('close-settings').addEventListener('click', closeSettingsPanel);

  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      saveSettings({ color: btn.dataset.color });
      updatePreview();
      refreshAllTimestamps();
    });
  });

  document.querySelectorAll('.time-format-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.time-format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings({ timeFormat: btn.dataset.format });
      updatePreview();
      refreshAllTimestamps();
    });
  });

  document.querySelectorAll('.date-format-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.date-format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings({ dateFormat: btn.dataset.format });
      updatePreview();
      refreshAllTimestamps();
    });
  });

  document.querySelectorAll('.show-date-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.show-date-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings({ showDate: btn.dataset.show === 'true' });
      updatePreview();
      refreshAllTimestamps();
    });
  });
}

function updateSettingsUI() {
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.color === currentSettings.color);
  });
  document.querySelectorAll('.time-format-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.format === currentSettings.timeFormat);
  });
  document.querySelectorAll('.date-format-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.format === currentSettings.dateFormat);
  });
  document.querySelectorAll('.show-date-btn').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.show === 'true') === currentSettings.showDate);
  });
  updatePreview();
}

function updatePreview() {
  const previewText = document.getElementById('preview-text');
  const preview = document.getElementById('timestamp-preview');
  if (previewText && preview) {
    previewText.textContent = formatTimestamp(new Date(), currentSettings);
    preview.style.color = currentSettings.color;
  }
}

// ─── Init ──────────────────────────────────────────────────────────────────

function init() {
  loadSettings();
  loadTimestamps();
  createSettingsButton();
  createSettingsPanel();
  setupEventListeners();

  // Don't snapshot "pre-existing" messages here — at document_start the SPA
  // usually hasn't rendered any messages into the DOM yet, so this would
  // capture an empty set and later treat every real (old) message as brand
  // new, stamping it with the current time. currentConversationId stays
  // null so the first MutationObserver tick runs resetForConversation()
  // once real content exists, and the snapshot happens there instead.
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
