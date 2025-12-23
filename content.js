const CONFIG = {
  defaults: {
    color: '#6b7280',
    timeFormat: '12h',
    dateFormat: 'letters',
    showDate: true
  },
  messageSelectors: [
    '[data-message-author-role="user"]',
    '[data-message-id]',
    '.group.w-full.text-token-text-primary[data-testid*="conversation-turn"]',
    'div[class*="agent-turn"]:has(div[data-message-author-role="user"])'
  ],
  storageKeys: {
    timestamps: 'chatgpt_timestamps',
    settings: 'chatgpt_timestamp_settings'
  }
};

let currentSettings = { ...CONFIG.defaults };
let messageTimestamps = {};
let processedMessages = new Set();

function generateMessageId(messageElement) {
  const text = messageElement.textContent.trim().substring(0, 200);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash;
  }
  return `msg_${Math.abs(hash).toString(36)}`;
}

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

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([CONFIG.storageKeys.settings], (result) => {
      if (result[CONFIG.storageKeys.settings]) {
        currentSettings = { ...CONFIG.defaults, ...result[CONFIG.storageKeys.settings] };
      }
      resolve(currentSettings);
    });
  });
}

async function saveSettings(settings) {
  currentSettings = { ...currentSettings, ...settings };
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [CONFIG.storageKeys.settings]: currentSettings }, resolve);
  });
}

async function loadTimestamps() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CONFIG.storageKeys.timestamps], (result) => {
      if (result[CONFIG.storageKeys.timestamps]) {
        messageTimestamps = result[CONFIG.storageKeys.timestamps];
      }
      resolve(messageTimestamps);
    });
  });
}

async function saveTimestamps() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CONFIG.storageKeys.timestamps]: messageTimestamps }, resolve);
  });
}

function extractTimestampFromDOM(element) {
  // Try React internal data structure first
  const reactKey = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
  if (reactKey) {
    const fiber = element[reactKey];
    const messages = fiber?.return?.memoizedProps?.messages;
    const timestamp = messages?.[0]?.create_time;
    if (timestamp) {
      return new Date(timestamp * 1000).toISOString();
    }
  }
  
  // Fallback to DOM timestamp extraction
  let timeEl = element.querySelector('time[datetime]');
  
  if (!timeEl) {
    const turnContainer = element.closest('[data-testid^="conversation-turn"]');
    if (turnContainer) {
      timeEl = turnContainer.querySelector('time[datetime]');
    }
  }
  
  if (timeEl) {
    return timeEl.getAttribute('datetime');
  }
  
  return null;
}

function isUserMessage(element) {
  return element.matches('[data-message-author-role="user"]') || 
         element.closest('[data-message-author-role="user"]');
}

function findMessageContainer(element) {
  return element.closest('[data-message-author-role="user"]') || 
         element.closest('.group.w-full') || element;
}

async function processMessage(messageElement) {
  const container = findMessageContainer(messageElement);
  const messageId = generateMessageId(container);
  
  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  
  if (!messageTimestamps[messageId]) {
    const domTimestamp = extractTimestampFromDOM(container);
    if (domTimestamp) {
      messageTimestamps[messageId] = domTimestamp;
      await saveTimestamps();
    } else {
      // For new messages, wait for DOM to update before creating timestamp
      setTimeout(async () => {
        const delayedTimestamp = extractTimestampFromDOM(container);
        if (delayedTimestamp && !messageTimestamps[messageId]) {
          messageTimestamps[messageId] = delayedTimestamp;
          await saveTimestamps();
        }
      }, 500);
    }
  }
  
  if (messageTimestamps[messageId]) {
    attachTimestampDisplay(container, messageId);
  }
}

function attachTimestampDisplay(messageElement, messageId) {
  let timestampLabel = null;
  
  const showTimestamp = () => {
    if (timestampLabel) return;
    
    const timestamp = messageTimestamps[messageId];
    if (!timestamp) return;
    
    const date = new Date(timestamp);
    const formattedTime = formatTimestamp(date, currentSettings);
    
    timestampLabel = document.createElement('div');
    timestampLabel.className = 'chatgpt-timestamp-label';
    timestampLabel.innerHTML = `<span class="timestamp-text">${formattedTime}</span>`;
    timestampLabel.style.color = currentSettings.color;
    
    const rect = messageElement.getBoundingClientRect();
    timestampLabel.style.top = `${rect.top - 18}px`;
    timestampLabel.style.right = `${window.innerWidth - rect.right}px`;
    
    document.body.appendChild(timestampLabel);
    
    setTimeout(() => {
      timestampLabel.classList.add('visible');
    }, 0);
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
  
  messageElement.addEventListener('mouseenter', showTimestamp);
  messageElement.addEventListener('mouseleave', hideTimestamp);
}

function scanForMessages() {
  // Scan for messages with data-message-id (React approach)
  document.querySelectorAll('div[data-message-id]').forEach(div => {
    if (div.dataset.timestampProcessed) return;
    
    const reactKey = Object.keys(div).find(k => k.startsWith('__reactFiber$'));
    if (reactKey) {
      const fiber = div[reactKey];
      const messages = fiber?.return?.memoizedProps?.messages;
      const timestamp = messages?.[0]?.create_time;
      if (timestamp) {
        const messageId = generateMessageId(div);
        if (!messageTimestamps[messageId]) {
          messageTimestamps[messageId] = new Date(timestamp * 1000).toISOString();
          saveTimestamps();
        }
        attachTimestampDisplay(div, messageId);
        div.dataset.timestampProcessed = 'true';
      }
    }
  });
  
  // Fallback to original selectors
  CONFIG.messageSelectors.forEach(selector => {
    const messages = document.querySelectorAll(selector);
    messages.forEach(msg => {
      if (isUserMessage(msg)) {
        processMessage(msg);
      }
    });
  });
}

function setupObserver() {
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check for React messages first
          if (node.matches && node.matches('div[data-message-id]')) {
            setTimeout(() => {
              const reactKey = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
              if (reactKey) {
                const fiber = node[reactKey];
                const messages = fiber?.return?.memoizedProps?.messages;
                const timestamp = messages?.[0]?.create_time;
                if (timestamp) {
                  const messageId = generateMessageId(node);
                  if (!messageTimestamps[messageId]) {
                    messageTimestamps[messageId] = new Date(timestamp * 1000).toISOString();
                    saveTimestamps();
                  }
                  attachTimestampDisplay(node, messageId);
                }
              }
            }, 100);
          }
          
          // Fallback to original processing
          if (isUserMessage(node)) processMessage(node);
          
          CONFIG.messageSelectors.forEach(selector => {
            const messages = node.querySelectorAll?.(selector) || [];
            messages.forEach(msg => {
              if (isUserMessage(msg)) processMessage(msg);
            });
          });
        }
      });
    });
    
    setTimeout(scanForMessages, 500);
  }).observe(document.querySelector('main') || document.body, {
    childList: true,
    subtree: true
  });
}

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
      if (panel && panel.style.display !== 'none') {
        closeSettingsPanel();
      }
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
  const svgs = button.querySelectorAll('svg');
  svgs.forEach(svg => {
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
            <circle cx="12" cy="10" r="4"></circle>
            <circle cx="8" cy="14" r="4"></circle>
            <circle cx="16" cy="14" r="4"></circle>
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
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
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
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
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
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
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
      
      <div class="setting-group">
        <div class="setting-row">
          <button class="useless-btn" id="useless-button">Do Nothing</button>
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
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  });
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

function attachSettingsPanelListeners() {
  document.getElementById('close-settings').addEventListener('click', closeSettingsPanel);
  
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      await saveSettings({ color: btn.dataset.color });
      updatePreview();
      refreshAllTimestamps();
    });
  });

  document.querySelectorAll('.time-format-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.time-format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await saveSettings({ timeFormat: btn.dataset.format });
      updatePreview();
      refreshAllTimestamps();
    });
  });
  
  document.querySelectorAll('.date-format-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.date-format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await saveSettings({ dateFormat: btn.dataset.format });
      updatePreview();
      refreshAllTimestamps();
    });
  });
  
  document.querySelectorAll('.show-date-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.show-date-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await saveSettings({ showDate: btn.dataset.show === 'true' });
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

function refreshAllTimestamps() {
  document.querySelectorAll('.chatgpt-timestamp-label').forEach(label => label.remove());
  processedMessages.clear();
  scanForMessages();
}

async function init() {
  await loadSettings();
  await loadTimestamps();
  createSettingsButton();
  createSettingsPanel();
  scanForMessages();
  setupObserver();
  setupEventListeners();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}