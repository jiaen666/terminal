// ===== Super Terminal v2 - Multi-Protocol with Groups =====
import RFB from '@novnc/novnc';

const state = {
  tabs: [],
  activeTabId: 'welcome',
  sessions: [],
  groups: [],
  ws: null,
  contextSessionId: null,
  contextGroupId: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  groupList: $('#group-list'),
  tabBar: $('#tab-bar'),
  terminalContainer: $('#terminal-container'),
  statusText: $('#status-text'),
  statusConn: $('#status-conn'),
  connModal: $('#conn-modal'),
  quickModal: $('#quick-modal'),
  groupModal: $('#group-modal'),
  modalTitle: $('#modal-title'),
  contextMenu: $('#context-menu'),
  groupContextMenu: $('#group-context-menu'),
  moveMenu: $('#move-menu'),
  resizeHandle: $('#resize-handle'),
  sidebar: $('#sidebar'),
};


// ===== Global Keyboard Guard =====
// Prevents Guacamole.Keyboard from hijacking keystrokes when modal is open.
// Does NOT block normal input fields.
document.addEventListener('keydown', function(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
  if (!dom.connModal.classList.contains('hidden') || 
      !dom.quickModal.classList.contains('hidden') ||
      !dom.groupModal.classList.contains('hidden')) {
    e.stopImmediatePropagation();
  }
}, true);
document.addEventListener('keyup', function(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
  if (!dom.connModal.classList.contains('hidden') || 
      !dom.quickModal.classList.contains('hidden') ||
      !dom.groupModal.classList.contains('hidden')) {
    e.stopImmediatePropagation();
  }
}, true);


// ===== WebSocket =====
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}?token=${encodeURIComponent(getToken())}`);
  state.ws.onopen = () => {
    setStatus('已连接服务器', true);
    // Reconnect active SSH/Telnet sessions
    reconnectActiveSessions();
  };
  state.ws.onmessage = (e) => { try { handleWS(JSON.parse(e.data)); } catch {} };
  state.ws.onclose = () => { state.tabs.forEach(t => { t.connected = false; }); updateStatusConn(); setStatus('断开, 重连中...', false); setTimeout(connectWebSocket, 2000); };
  state.ws.onerror = () => setStatus('WebSocket错误', false);
}

function reconnectActiveSessions() {
  // Re-establish SSH/Telnet connections that were active before WS dropped
  state.tabs.forEach(tab => {
    if (!tab.connected && tab._autoReconnect && (tab.protocol === 'ssh' || tab.protocol === 'telnet')) {
      tab._autoReconnect = false;
      if (tab.protocol === 'telnet') {
        sendWS({ type: 'telnet-connect', tabId: tab.id, host: tab.host, port: tab.port,
          termCols: tab.terminal?.cols, termRows: tab.terminal?.rows });
      } else {
        sendWS({ type: 'ssh-connect', tabId: tab.id, host: tab.host, port: tab.port,
          username: tab.username, password: tab.password, privateKey: tab.privateKey,
          termCols: tab.terminal?.cols, termRows: tab.terminal?.rows });
      }
    }
  });
}

function sendWS(data) { console.log('sendWS:', data.type, 'readyState:', state.ws?.readyState); if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(data)); else console.log('sendWS FAILED: ws not ready'); }

function handleWS(msg) {
  const tab = findTab(msg.tabId);
  switch (msg.type) {
    case 'connected':
      if (tab) { tab.connected = true; tab._autoReconnect = true; removeOverlay(tab); if (tab.rfb) tab.rfb.focus(); else if (tab.terminal) tab.terminal.focus(); else if (tab.canvas) tab.canvas.focus(); }
      updateStatusConn(); setStatus('已连接', true);
      break;
    case 'output':
      if (tab?.terminal) tab.terminal.write(msg.data);
      break;
    case 'error':
      if (tab) { removeOverlay(tab); tab._autoReconnect = false; if (tab.terminal) tab.terminal.writeln('\r\n\x1b[31m[Error] ' + msg.message + '\x1b[0m'); else showCanvasError(tab, msg.message); tab.connected = false; tab._hadError = true; }
      updateStatusConn(); setStatus('错误: ' + msg.message, false);
      break;
    case 'disconnected':
      if (tab) { tab.connected = false; tab._autoReconnect = false; if (tab.terminal) tab.terminal.writeln('\r\n\x1b[33m[Disconnected] ' + (msg.message || '') + '\x1b[0m'); else if (!tab._hadError) showCanvasError(tab, '断开连接'); tab._hadError = false; }
      updateStatusConn(); setStatus('已断开', false);
      break;
    case 'sftp-items':
      // Only process if this is the most recent request
      if (msg._reqId && msg._reqId !== sftpState._reqId) break;
      if (msg.path === sftpState._pendingList) {
        sftpState.items = msg.items;
        sftpRenderItems(msg.items);
        $('#sftp-status').textContent = msg.items.length + ' 项';
      }
      break;
    case 'sftp-download-start':
      sftpState._downloadSize = 0;
      $('#sftp-status').textContent = '下载中...';
      break;
    case 'sftp-download-chunk':
      (function() {
        var b64 = msg.data;
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var blob = new Blob([bytes]);
        if (window.showSaveFilePicker) {
          window.showSaveFilePicker({ suggestedName: msg.fileName }).then(function(h) {
            h.createWritable().then(function(w) { w.write(blob).then(function() { w.close(); $('#sftp-status').textContent = '已保存'; }); });
          }).catch(function() { downloadBlob(blob, msg.fileName); });
        } else {
          downloadBlob(blob, msg.fileName);
        }
      })();
      break;
    case 'sftp-download-end':
      break;
    case 'sftp-upload-done':
      sftpListDir(sftpState.currentPath);
      $('#sftp-status').textContent = '上传完成';
      break;
    case 'sftp-error':
      $('#sftp-status').textContent = '错误: ' + msg.message;
      break;
    case 'rdp-bitmap':
      if (tab?.canvas) renderRDPBitmap(tab, msg);
      break;
  }
}

// ===== Tab Management =====
function genId() { return 'tab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
function findTab(id) { return state.tabs.find(t => t.id === id); }

function createTab(title, host, protocol) {
  const tabId = genId();
  const isGraphical = protocol === 'vnc' || protocol === 'rdp';
  const icons = { ssh: '🔒', telnet: '📡', vnc: '🖥️', rdp: '🪟' };
  const icon = icons[protocol] || '🔌';
  const shortTitle = title || host || '新连接';

  const tabContent = document.createElement('div');
  tabContent.className = 'tab-content';
  tabContent.id = 'tab-content-' + tabId;

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabid = tabId;
  tabEl.innerHTML = `<span class="tab-title">${icon} ${escapeHtml(shortTitle)}</span><span class="tab-close">&times;</span>`;
  const spacer = $('#tab-bar-spacer');
  dom.tabBar.insertBefore(tabEl, spacer);

  // Sidebar toggle
  if (!$('#btn-toggle-sidebar')._init) {
    $('#btn-toggle-sidebar')._init = true;
    $('#btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  }

  let tab = {
    id: tabId, title: shortTitle, host, protocol,
    username: '', password: '', port: 3389,
    tabContent, tabEl, connected: false,
    terminal: null, canvas: null, rfb: null,
    fitAddon: null, resizeObserver: null,
    bitmapBuf: null,
  };

  if (isGraphical) {
    // Canvas-based viewer for VNC/RDP
    const wrapper = document.createElement('div');
    wrapper.className = 'canvas-wrapper';
    const canvas = document.createElement('canvas');
    canvas.style.cursor = 'none';
    wrapper.appendChild(canvas);
    const status = document.createElement('div');
    status.className = 'canvas-status';
    status.textContent = protocol.toUpperCase();
    wrapper.appendChild(status);
    tabContent.appendChild(wrapper);
    tab.canvas = canvas;
    tab.canvasWrapper = wrapper;
    dom.terminalContainer.appendChild(tabContent);

    // VNC/RDP setup deferred to connectToDevice -> setupGuacRDP
    // Keep canvas wrapper intact
  } else {
    // xterm.js terminal for SSH/Telnet
    const termWrapper = document.createElement('div');
    termWrapper.className = 'terminal-wrapper';
    termWrapper.id = 'terminal-' + tabId;
    tabContent.appendChild(termWrapper);
    dom.terminalContainer.appendChild(tabContent);

    const terminal = new Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontSize: 14,
      fontFamily: '"SF Mono","Monaco","Menlo","Consolas","Courier New",monospace',
      theme: { background: '#0d0d0d', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a' },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    const searchAddon = new SearchAddon.SearchAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    terminal.loadAddon(fitAddon); terminal.loadAddon(searchAddon); terminal.loadAddon(webLinksAddon);
    terminal.open(document.getElementById('terminal-' + tabId));
    fitAddon.fit();

    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch(e) {}
      if (tab.connected) sendWS({ type: 'resize', tabId, rows: terminal.rows, cols: terminal.cols });
    });
    ro.observe(termWrapper);

    terminal.onData(data => sendWS({ type: 'input', tabId, data }));

    tab.terminal = terminal; tab.fitAddon = fitAddon; tab.resizeObserver = ro;
  }

  state.tabs.push(tab);

  tabEl.addEventListener('click', e => { if (!e.target.closest('.tab-close')) switchTab(tabId); });
  tabEl.querySelector('.tab-close').addEventListener('click', e => { e.stopPropagation(); closeTab(tabId); });
  
  // Right-click context menu for tabs
  tabEl.addEventListener('contextmenu', function(e) {
    e.preventDefault(); e.stopPropagation();
    showTabContextMenu(e.clientX, e.clientY, tab);
  });
  tabEl.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeTab(tabId); } });

  switchTab(tabId);
  return tab;
}

function toggleSidebar() {
  var sidebar = $('#sidebar');
  var handle = $('#resize-handle');
  var btn = $('#btn-toggle-sidebar');
  var collapsed = sidebar.classList.toggle('collapsed');
  handle.classList.toggle('collapsed', collapsed);
  btn.classList.toggle('collapsed', collapsed);
  btn.textContent = '◀';
  btn.title = collapsed ? '展开侧边栏' : '折叠侧边栏';
  // Update tooltips for collapsed icons
  updateCollapsedTooltips();
  // Trigger resize on active tab's terminal/display
  setTimeout(function() {
    var tab = state.tabs.find(function(t) { return t.id === state.activeTabId; });
    if (tab && tab.fitAddon) { try { tab.fitAddon.fit(); } catch(e) {} }
    if (tab && tab.terminal) { try { tab.fitAddon.fit(); } catch(e) {} }
  }, 300);
}

function updateCollapsedTooltips() {
  $$('#group-list .session-item').forEach(function(item) {
    var nameEl = item.querySelector('.session-name');
    var hostEl = item.querySelector('.session-host');
    var name = nameEl ? nameEl.textContent : '';
    var host = hostEl ? hostEl.textContent : '';
    item.setAttribute('data-tooltip', name + '\n' + host);
  });
}

function switchTab(tabId) {
  state.tabs.forEach(t => { t.tabEl.classList.remove('active'); t.tabContent.classList.remove('active'); });
  $('#tab-content-welcome')?.classList.remove('active');
  const wt = document.querySelector('.tab[data-tabid="welcome"]');
  if (wt) wt.classList.remove('active');
  if (tabId === 'welcome') { $('#tab-content-welcome')?.classList.add('active'); if (wt) wt.classList.add('active'); state.activeTabId = 'welcome'; updateStatusConn(); return; }
  const tab = findTab(tabId);
  if (!tab) return;
  tab.tabEl.classList.add('active'); tab.tabContent.classList.add('active'); state.activeTabId = tabId;
  try { tab.fitAddon?.fit(); } catch(e) {}
  if (tab.terminal) tab.terminal.focus();
  updateStatusConn();

  // Auto-update SFTP panel to reflect the new active tab
  var sftpModal = $('#sftp-modal');
  if (sftpModal && !sftpModal.classList.contains('hidden') && tab.protocol === 'ssh' && tab.connected) {
    sftpState.tabId = tab.id;
    sftpState.host = tab.host;
    sftpState.port = tab.port || 22;
    sftpState.username = tab.username;
    sftpState.password = tab.password || '';
    sftpState.privateKey = tab.privateKey || '';
    sftpState._reqId = Date.now();
    $('#sftp-modal-title').textContent = '📁 文件传输 - ' + tab.username + '@' + tab.host;
    sftpListDir(sftpState.currentPath);
  }
}

function closeTab(tabId) {
  const idx = state.tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  sendWS({ type: 'disconnect', tabId });
  tab.connected = false;
  if (tab.rfb) { try { tab.rfb.disconnect(); } catch(e) {} }
  if (tab.guacClient) { try { tab.guacClient.disconnect(); } catch(e) {} }
  if (tab.guacKeyboard) { unregisterGuacKeyboard(tab.guacKeyboard); }
  if (tab.vncKeyboard) { unregisterGuacKeyboard(tab.vncKeyboard); }
  tab.resizeObserver?.disconnect();
  tab.terminal?.dispose();
  tab.tabContent?.remove();
  tab.tabEl?.remove();
  state.tabs.splice(idx, 1);
  if (state.activeTabId === tabId) {
    if (state.tabs.length > 0) switchTab(state.tabs[state.tabs.length - 1].id);
    else switchTab('welcome');
  }
  updateStatusConn();
}

function closeActiveTab() { if (state.activeTabId !== 'welcome') closeTab(state.activeTabId); }

function showOverlay(tab) {
  const o = document.createElement('div'); o.className = 'connecting-overlay'; o.id = 'overlay-' + tab.id;
  o.innerHTML = '<div class="connecting-spinner"></div><div class="connecting-text">正在连接 ' + escapeHtml(tab.host) + '...</div>';
  (tab.canvasWrapper || tab.tabContent).appendChild(o);
}

function removeOverlay(tab) { const o = document.getElementById('overlay-' + tab.id); if (o) o.remove(); }
function showCanvasError(tab, msg) {
  if (tab.canvas) {
    const ctx = tab.canvas.getContext('2d');
    ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, tab.canvas.width, tab.canvas.height);
    ctx.fillStyle = '#f38ba8'; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('[Error] ' + msg, tab.canvas.width/2, tab.canvas.height/2);
  }
}

function updateStatusConn() {
  if (state.activeTabId === 'welcome') { dom.statusConn.textContent = '未连接'; dom.statusConn.style.color = 'var(--text-muted)'; return; }
  const tab = findTab(state.activeTabId);
  dom.statusConn.textContent = tab?.connected ? '已连接: ' + tab.host : '未连接';
  dom.statusConn.style.color = tab?.connected ? 'var(--success)' : 'var(--warning)';
}

function setStatus(text, ok) { dom.statusText.textContent = text; dom.statusText.style.color = ok ? 'var(--text-muted)' : 'var(--danger)'; }


// ===== Guacamole Keyboard Management =====
var _guacKeyboards = [];
function registerGuacKeyboard(kb) { if (kb && _guacKeyboards.indexOf(kb) === -1) _guacKeyboards.push(kb); }
function unregisterGuacKeyboard(kb) { var i = _guacKeyboards.indexOf(kb); if (i !== -1) _guacKeyboards.splice(i, 1); }
function pauseAllGuacKeyboards() {
  _guacKeyboards.forEach(function(kb) {
    if (!kb._paused) { kb._savedOnkeydown = kb.onkeydown; kb._savedOnkeyup = kb.onkeyup; kb._paused = true; }
    kb.onkeydown = null; kb.onkeyup = null;
  });
}
function resumeAllGuacKeyboards() {
  _guacKeyboards.forEach(function(kb) {
    if (kb._paused) { kb.onkeydown = kb._savedOnkeydown; kb.onkeyup = kb._savedOnkeyup; kb._paused = false; }
  });
}

// ===== RDP Bitmap Rendering =====
function renderRDPBitmap(tab, msg) {
  if (!tab.canvas) return;
  var canvas = tab.canvas;
  var ctx = canvas.getContext('2d');
  
  // Resize canvas if needed
  if (msg.destRight > canvas.width || msg.destBottom > canvas.height) {
    canvas.width = Math.max(canvas.width, msg.destRight);
    canvas.height = Math.max(canvas.height, msg.destBottom);
  }
  
  try {
    var binary = atob(msg.data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    
    // Create ImageData from raw bitmap
    var bpp = msg.bitsPerPixel || 32;
    var imgData = ctx.createImageData(msg.width, msg.height);
    var srcIdx = 0;
    
    for (var y = 0; y < msg.height; y++) {
      for (var x = 0; x < msg.width; x++) {
        var dstIdx = (y * msg.width + x) * 4;
        if (bpp === 32) {
          imgData.data[dstIdx] = bytes[srcIdx + 2];     // R
          imgData.data[dstIdx + 1] = bytes[srcIdx + 1]; // G
          imgData.data[dstIdx + 2] = bytes[srcIdx];     // B
          imgData.data[dstIdx + 3] = 255;
          srcIdx += 4;
        } else if (bpp === 24) {
          imgData.data[dstIdx] = bytes[srcIdx + 2];
          imgData.data[dstIdx + 1] = bytes[srcIdx + 1];
          imgData.data[dstIdx + 2] = bytes[srcIdx];
          imgData.data[dstIdx + 3] = 255;
          srcIdx += 3;
        } else if (bpp === 16) {
          var pixel = bytes[srcIdx] | (bytes[srcIdx + 1] << 8);
          imgData.data[dstIdx] = ((pixel >> 10) & 0x1F) * 8;
          imgData.data[dstIdx + 1] = ((pixel >> 5) & 0x1F) * 8;
          imgData.data[dstIdx + 2] = (pixel & 0x1F) * 8;
          imgData.data[dstIdx + 3] = 255;
          srcIdx += 2;
        } else if (bpp === 8) {
          imgData.data[dstIdx] = bytes[srcIdx];
          imgData.data[dstIdx + 1] = bytes[srcIdx];
          imgData.data[dstIdx + 2] = bytes[srcIdx];
          imgData.data[dstIdx + 3] = 255;
          srcIdx += 1;
        }
      }
    }
    
    ctx.putImageData(imgData, msg.destLeft || 0, msg.destTop || 0);
  } catch(e) {
    console.error('Bitmap render error:', e);
  }
}


// ===== RDP Input Handling (node-rdpjs) =====
function setupRDPInput(tab) {
  if (!tab.canvas) return;
  
  tab.canvas.addEventListener('mousemove', function(e) {
    if (!tab.connected) return;
    var rect = tab.canvas.getBoundingClientRect();
    var x = Math.round((e.clientX - rect.left) * (tab.canvas.width / rect.width));
    var y = Math.round((e.clientY - rect.top) * (tab.canvas.height / rect.height));
    sendWS({ type: 'rdp-pointer', tabId: tab.id, x: x, y: y, button: 0, isPressed: false });
  });
  
  tab.canvas.addEventListener('mousedown', function(e) {
    if (!tab.connected) return;
    var rect = tab.canvas.getBoundingClientRect();
    var x = Math.round((e.clientX - rect.left) * (tab.canvas.width / rect.width));
    var y = Math.round((e.clientY - rect.top) * (tab.canvas.height / rect.height));
    sendWS({ type: 'rdp-pointer', tabId: tab.id, x: x, y: y, button: e.button || 1, isPressed: true });
  });
  
  tab.canvas.addEventListener('mouseup', function(e) {
    if (!tab.connected) return;
    var rect = tab.canvas.getBoundingClientRect();
    var x = Math.round((e.clientX - rect.left) * (tab.canvas.width / rect.width));
    var y = Math.round((e.clientY - rect.top) * (tab.canvas.height / rect.height));
    sendWS({ type: 'rdp-pointer', tabId: tab.id, x: x, y: y, button: e.button || 1, isPressed: false });
  });
  
  tab.canvas.tabIndex = 0;
  tab.canvas.focus();
  tab.canvas.addEventListener('keydown', function(e) {
    if (!tab.connected) return;
    e.preventDefault();
    sendWS({ type: 'rdp-key', tabId: tab.id, scancode: e.keyCode, isPressed: true });
  });
  tab.canvas.addEventListener('keyup', function(e) {
    if (!tab.connected) return;
    e.preventDefault();
    sendWS({ type: 'rdp-key', tabId: tab.id, scancode: e.keyCode, isPressed: false });
  });
}


// ===== VNC Setup (noVNC) =====
function setupVNC(tab) {
  const canvas = tab.canvas;
  canvas.width = 1280; canvas.height = 720;

  const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/vnc?host=${encodeURIComponent(tab.host)}&port=${tab.port || 5900}`;

  const rfb = new RFB(canvas, wsUrl, {
    credentials: { password: tab.password || '' },
    resizeSession: true,
    scaleViewport: true,
    clipViewport: false,
  });

  rfb.addEventListener('connect', () => { tab.connected = true; removeOverlay(tab); updateStatusConn(); setStatus('VNC 已连接', true); });
  rfb.addEventListener('disconnect', (e) => { tab.connected = false; showOverlay(tab); updateStatusConn(); if (e.detail.clean) { setStatus('VNC 断开', false); } else { setStatus('VNC 错误: ' + (e.detail.reason || ''), false); setTimeout(() => { if (tab === findTab(tab.id)) showCanvasError(tab, 'VNC: ' + (e.detail.reason || '连接失败')); }, 500); } });
  rfb.addEventListener('credentialsrequired', () => { rfb.clipViewport = false; });
  rfb.addEventListener('desktopname', (e) => { const t = findTab(tab.id); if (t) { t.title = e.detail.name; const tel = t.tabEl?.querySelector('.tab-title'); if (tel) tel.textContent = '🖥️ ' + e.detail.name; } });

  tab.rfb = rfb;
  tab.canvas.style.cursor = 'default';
}




// ===== RDP Bridge Connection =====
async function connectRDPBridge(tab) {
  try {
    var resp = await apiFetch('/api/rdp-bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: tab.host,
        port: tab.port || 3389,
        username: tab.username || 'Administrator',
        password: tab.password || ''
      })
    });
    var data = await resp.json();
    
    // Now connect via VNC proxy to the bridge
    var wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/vnc?host=${data.host}&port=${data.vncPort}`;
    
    var canvas = tab.canvas;
    canvas.width = 1280; canvas.height = 720;
    
    var rfb = new RFB(canvas, wsUrl, {
      credentials: { password: '' },
      resizeSession: true,
      scaleViewport: true,
      clipViewport: false,
    });
    
    rfb.addEventListener('connect', () => { 
      tab.connected = true; 
      removeOverlay(tab); 
      updateStatusConn(); 
      setStatus('RDP (via bridge) 已连接', true);
    });
    
    rfb.addEventListener('disconnect', (e) => { 
      tab.connected = false; 
      showOverlay(tab); 
      updateStatusConn(); 
      // Cleanup bridge on server
      apiFetch('/api/rdp-bridge/' + data.id, { method: 'DELETE' }).catch(() => {});
      if (e.detail.clean) { setStatus('RDP 断开', false); } 
      else { setStatus('RDP 错误: ' + (e.detail.reason || ''), false); }
    });
    
    tab.rfb = rfb;
    tab.canvas.style.cursor = 'default';
    tab._bridgeId = data.id;
    
  } catch(e) {
    showCanvasError(tab, 'RDP桥接失败: ' + e.message);
    console.error('RDP bridge error:', e);
  }
}

// ===== RDP via Guacamole (guacd) =====
function setupGuacRDP(tab) {
  var canvas = tab.canvas;
  var wrapper = tab.canvasWrapper;
  if (!wrapper) return;

  
  // Prepare Guacamole display
  var displayDiv = document.createElement('div');
  displayDiv.style.cssText = 'flex:1;width:100%;height:100%;overflow:hidden;background:#000;min-width:0;min-height:0;';
  if (canvas) canvas.style.display = "none"; wrapper.appendChild(displayDiv);
  
  var protoLabel = (tab.protocol || 'rdp').toUpperCase();
  var statusDiv = document.createElement('div');
  statusDiv.className = 'canvas-status';
  statusDiv.textContent = protoLabel + ' 连接中...';
  wrapper.appendChild(statusDiv);
  tab.rdpStatus = statusDiv;
  
  if (typeof Guacamole === 'undefined') {
    statusDiv.textContent = '正在加载 Guacamole...';
    statusDiv.style.color = '#f9e2af';
    // Retry after a moment - the script may still be loading
    var retries = 0;
    var retryInterval = setInterval(function() {
      retries++;
      if (typeof Guacamole !== 'undefined') {
        clearInterval(retryInterval);
        statusDiv.textContent = 'RDP 连接中...';
        statusDiv.style.color = '';
        setupGuacRDPInternal(tab, displayDiv, statusDiv);
      } else if (retries >= 30) {
        clearInterval(retryInterval);
        statusDiv.textContent = 'Guacamole 加载失败，请刷新页面';
        statusDiv.style.color = '#f38ba8';
      }
    }, 500);
    return;
  }
  setupGuacRDPInternal(tab, displayDiv, statusDiv);
}

function setupGuacRDPInternal(tab, displayDiv, statusDiv) {
  
  var wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host +
    '/ws/guac?protocol=' + encodeURIComponent(tab.protocol || 'rdp') +
      '&host=' + encodeURIComponent(tab.host) +
    '&port=' + encodeURIComponent(tab.port || 3389) +
    '&username=' + encodeURIComponent(tab.username || '') +
    '&password=' + encodeURIComponent(tab.password || '') +
    '&security=nla&ignore-cert=true' +
    '&width=' + (displayDiv.clientWidth || wrapper.clientWidth || 1280) + '&height=' + (displayDiv.clientHeight || wrapper.clientHeight || 720);
  
  try {
    var tun = new Guacamole.WebSocketTunnel(wsUrl);
    var cli = new Guacamole.Client(tun);
    tab._rdpWidth = displayDiv.clientWidth || wrapper.clientWidth || 1280;
    tab._rdpHeight = displayDiv.clientHeight || wrapper.clientHeight || 720;
    tab.guacClient = cli;
    
    var dsp = cli.getDisplay();
    displayDiv.appendChild(dsp.getElement());
    
    // Force the Guacamole display to fill its container
    var dspEl = dsp.getElement();
    dspEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    
    // Ensure the display scales correctly after DOM layout
    setTimeout(function() {
      var w = displayDiv.clientWidth || 1280;
      var h = displayDiv.clientHeight || 720;
      if (w > 0 && h > 0) {
        dsp.scale(Math.min(w / (tab._rdpWidth || 1280), h / (tab._rdpHeight || 720)));
        cli.sendSize(w, h);
      }
    }, 200);
    
    cli.onstatechange = function(s) {
      if (s === 3) {
        tab.connected = true;
        removeOverlay(tab);
        updateStatusConn();
        var protoLabel2 = (tab.protocol || 'rdp').toUpperCase();
        setStatus(protoLabel2 + ' 已连接', true);
        if (tab.rdpStatus) tab.rdpStatus.style.display = 'none';
      } else if (s === 5) {
        tab.connected = false;
        updateStatusConn();
        var protoLabel3 = (tab.protocol || 'rdp').toUpperCase();
        if (!tab._hadError) setStatus(protoLabel3 + ' 断开', false);
        tab._hadError = false;
      } else if (s === 6 || s === 7) {
        tab.connected = false;
        var err = cli.getErrorMessage() || '未知错误';
        if (tab.rdpStatus) { tab.rdpStatus.textContent = '错误: ' + err; tab.rdpStatus.style.color = '#f38ba8'; }
        var protoLabel4 = (tab.protocol || 'rdp').toUpperCase();
        setStatus(protoLabel4 + '错误: ' + err, false);
        tab._hadError = true;
      }
    };
    
    // Handle display resize
    var ro = new ResizeObserver(function(entries) {
      for (var entry of entries) {
        var w = entry.contentRect.width;
        var h = entry.contentRect.height;
        if (w > 0 && h > 0 && tab.connected) {
          cli.sendSize(w, h);
        }
      }
    });
    ro.observe(displayDiv);
    tab._displayRO = ro;

    var kb = new Guacamole.Keyboard(document);
    kb.onkeydown = function(k) { 
      if (tab.connected && state.activeTabId === tab.id && 
          dom.connModal.classList.contains('hidden') &&
          dom.quickModal.classList.contains('hidden') &&
          dom.groupModal.classList.contains('hidden') &&
          document.activeElement?.tagName !== 'INPUT' &&
          document.activeElement?.tagName !== 'TEXTAREA' &&
          document.activeElement?.tagName !== 'SELECT') cli.sendKeyEvent(1, k); 
    };
    kb.onkeyup = function(k) { 
      if (tab.connected && state.activeTabId === tab.id && 
          dom.connModal.classList.contains('hidden') &&
          dom.quickModal.classList.contains('hidden') &&
          dom.groupModal.classList.contains('hidden') &&
          document.activeElement?.tagName !== 'INPUT' &&
          document.activeElement?.tagName !== 'TEXTAREA' &&
          document.activeElement?.tagName !== 'SELECT') cli.sendKeyEvent(0, k); 
    };
    tab.guacKeyboard = kb;
    registerGuacKeyboard(kb);
    
    var ms = new Guacamole.Mouse(dsp.getElement());
    ms.onmousedown = ms.onmouseup = ms.onmousemove = function(st) { cli.sendMouseState(st); };
    
    cli.connect();
  } catch(e) {
    if (tab.rdpStatus) { tab.rdpStatus.textContent = '初始化失败: ' + e.message; tab.rdpStatus.style.color = '#f38ba8'; }
    console.error('Guacamole error:', e);
  }
}

// ===== Connection =====
function connectToDevice(config) {
  const proto = config.protocol || 'ssh';
  const title = config.name || (config.username ? config.username + '@' + config.host : config.host);
  const tab = createTab(title, config.host, proto);
  tab.port = config.port || (proto === 'telnet' ? 23 : proto === 'vnc' ? 5900 : proto === 'rdp' ? 3389 : 22);
  tab.password = config.password || '';
  tab.username = config.username || '';

  showOverlay(tab);
  setStatus('正在连接 ' + config.host + '...', true);

  setTimeout(() => {
    try { tab.fitAddon?.fit(); } catch(e) {}
    if (proto === 'telnet') {
      tab._autoReconnect = true;
      sendWS({ type: 'telnet-connect', tabId: tab.id, host: config.host, port: config.port || 23, termCols: tab.terminal?.cols, termRows: tab.terminal?.rows });
    } else if (proto === 'rdp') {
      tab.username = config.username || '';
      tab.password = config.password || '';
      tab.port = config.port || 3389;
      setupGuacRDP(tab);
    } else if (proto === 'vnc') {
      tab.username = config.username || '';
      tab.password = config.password || '';
      tab.port = config.port || 5900;
      setupGuacRDP(tab);
    } else {
      tab._autoReconnect = true;
      sendWS({ type: 'ssh-connect', tabId: tab.id, host: config.host, port: config.port || 22, username: config.username, password: config.password, privateKey: config.privateKey, termCols: tab.terminal?.cols, termRows: tab.terminal?.rows });
    }
  }, 150);
}

// ===== Session & Group Management =====
async function loadSessions() { try { state.sessions = await (await apiFetch('/api/sessions')).json(); } catch(e) {} }
async function loadGroups() { try { state.groups = await (await apiFetch('/api/groups')).json(); } catch(e) {} }

async function loadAll() { await loadGroups(); await loadSessions(); renderAll(); }

async function saveSession(cfg) { try { await apiFetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }); await loadAll(); } catch(e) {} }
async function updateSession(id, cfg) { try { await apiFetch('/api/sessions/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }); await loadAll(); } catch(e) {} }
async function deleteSession(id) { try { await apiFetch('/api/sessions/' + id, { method: 'DELETE' }); await loadAll(); } catch(e) {} }

async function saveGroup(name, parentId) { try { await apiFetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parentId: parentId || '' }) }); await loadAll(); } catch(e) {} }
async function updateGroup(id, name) { try { await apiFetch('/api/groups/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); await loadAll(); } catch(e) {} }
async function deleteGroup(id) { try { await apiFetch('/api/groups/' + id, { method: 'DELETE' }); await loadAll(); } catch(e) {} }
async function moveSession(sessionId, groupId) {
  await updateSession(sessionId, { group: groupId });
}

function renderAll() { renderGroupList(); updateGroupSelect(); updateCollapsedTooltips(); }

function renderGroupList() {
  dom.groupList.innerHTML = '';
  if (state.groups.length === 0 && state.sessions.length === 0) {
    dom.groupList.innerHTML = '<div class="session-empty">📭 暂无保存的会话<br><small>点击 "+ 新建连接" 创建</small></div>';
    return;
  }

  // Unassigned sessions
  const unassigned = state.sessions.filter(s => !s.group || !state.groups.find(g => g.id === s.group));
  if (unassigned.length > 0) {
    renderGroupSection('未分组', '', unassigned, 0);
  }

  // Render root groups recursively
  const rootGroups = state.groups.filter(g => !g.parentId);
  rootGroups.forEach(group => renderGroupTree(group, 0));
}

function renderGroupTree(group, depth) {
  const sessions = state.sessions.filter(s => s.group === group.id);
  const childGroups = state.groups.filter(g => g.parentId === group.id);
  
  renderGroupSection(group.name, group.id, sessions, depth);
  
  // Recursively render children
  childGroups.forEach(child => renderGroupTree(child, depth + 1));
}

function renderGroupSection(name, groupId, sessions, depth) {
  depth = depth || 0;
  const section = document.createElement('div');
  section.className = 'group-section';
  section.style.marginLeft = (depth * 16) + 'px';

  const header = document.createElement('div');
  header.className = 'group-header';
  header.dataset.groupId = groupId;
  header.innerHTML = `
    <span class="group-arrow">▼</span>
    <span class="group-name">📁 ${escapeHtml(name || '未分组')}</span>
    <span class="group-count">${sessions.length}</span>`;

  header.addEventListener('click', () => {
    const contents = section.querySelector('.group-sessions');
    const arrow = header.querySelector('.group-arrow');
    const collapsed = contents.classList.toggle('collapsed');
    arrow.classList.toggle('collapsed', collapsed);
  });

  if (groupId) {
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      state.contextGroupId = groupId;
      showGroupContextMenu(e.clientX, e.clientY);
    });
  }

  const contents = document.createElement('div');
  contents.className = 'group-sessions';

  if (sessions.length === 0) {
    // Empty group - show nothing
  } else {
    const protoIcons = { ssh: '🔒', telnet: '📡', vnc: '🖥️', rdp: '🪟' };
    const protoLabels = { ssh: 'SSH', telnet: 'Telnet', vnc: 'VNC', rdp: 'RDP' };

    sessions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'session-item';
      item.dataset.sessionId = s.id;
      item.innerHTML = `<span class="session-icon">${protoIcons[s.protocol] || '🔌'}</span>
        <div class="session-info">
          <div class="session-name">${escapeHtml(s.name)}</div>
          <div class="session-host">${protoLabels[s.protocol] || s.protocol} | ${s.username || '(无)'}@${s.host}:${s.port}</div>
        </div>`;

      item.addEventListener('dblclick', () => {
        // Check if this connection is already open in a tab
        var existing = state.tabs.find(function(t) {
          return t.host === s.host && t.port === s.port && t.protocol === s.protocol &&
                 t.username === s.username;
        });
        if (existing) {
          // Switch to existing tab
          switchTab(existing.id);
          return;
        }
        // Open new connection
        connectToDevice({
          host: s.host, port: s.port, username: s.username,
          password: s.password, privateKey: s.privateKey,
          protocol: s.protocol, name: s.name,
        });
      });

      item.addEventListener('click', () => {
        $$('.session-item').forEach(el => el.style.background = '');
        item.style.background = 'var(--bg-hover)';
        // Single click in collapsed sidebar opens/switches session
        if ($('#sidebar').classList.contains('collapsed')) {
          var existing = state.tabs.find(function(t) {
            return t.host === s.host && t.port === s.port && t.protocol === s.protocol &&
                   t.username === s.username;
          });
          if (existing) { switchTab(existing.id); }
          else { connectToDevice({ host: s.host, port: s.port, username: s.username, password: s.password, privateKey: s.privateKey, protocol: s.protocol, name: s.name }); }
        }
      });

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.contextSessionId = s.id;
        showContextMenu(e.clientX, e.clientY);
      });

      contents.appendChild(item);
    });
  }

  section.appendChild(header);
  section.appendChild(contents);
  dom.groupList.appendChild(section);
}

function updateGroupSelect() {
  const select = $('#conn-group');
  if (!select) return;
  select.innerHTML = '<option value="">默认分组</option>';
  
  function addOptions(parentId, depth) {
    state.groups.filter(g => (g.parentId || '') === (parentId || '')).forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = '  '.repeat(depth) + g.name;
      select.appendChild(opt);
      addOptions(g.id, depth + 1);
    });
  }
  addOptions('', 0);
}

// ===== Context Menus =====
var _origShowContextMenu = showContextMenu;
showContextMenu = function(x, y) {
  _origShowContextMenu(x, y);
  var menu = $('#context-menu');
  if (!menu || !state.contextSessionId) return;
  var session = state.sessions.find(function(s) { return s.id === state.contextSessionId; });
  if (!session || session.protocol !== 'ssh') return;
  var activeTab = state.tabs.find(function(t) {
    return t.host === session.host && t.username === session.username && t.connected;
  });
  if (!activeTab) return; // no active SSH connection
  session.tabId = activeTab.id;
  var oldSftp = menu.querySelector('.sftp-item');
  if (oldSftp) oldSftp.remove();
  var sftpItem = document.createElement('div');
  sftpItem.className = 'context-item sftp-item';
  sftpItem.textContent = '📁 文件传输';
  sftpItem.addEventListener('click', function() {
    hideAllMenus();
    openSftpPanel(session);
  });
  var delItem = menu.querySelector('.danger');
  if (delItem) menu.insertBefore(sftpItem, delItem);
  else menu.appendChild(sftpItem);
};

function showContextMenu(x, y) {
  dom.contextMenu.classList.remove('hidden');
  dom.contextMenu.style.left = x + 'px'; dom.contextMenu.style.top = y + 'px';
  dom.moveMenu.classList.add('hidden');
  dom.groupContextMenu.classList.add('hidden');
}

function showGroupContextMenu(x, y) {
  dom.groupContextMenu.classList.remove('hidden');
  dom.groupContextMenu.style.left = x + 'px'; dom.groupContextMenu.style.top = y + 'px';
  dom.contextMenu.classList.add('hidden');
  dom.moveMenu.classList.add('hidden');
}

function showMoveMenu(x, y) {
  dom.moveMenu.innerHTML = '';
  dom.moveMenu.classList.remove('hidden');
  dom.moveMenu.style.left = x + 'px'; dom.moveMenu.style.top = y + 'px';

  const unassigned = document.createElement('div');
  unassigned.className = 'context-item'; unassigned.dataset.groupId = '';
  unassigned.textContent = '📁 未分组';
  unassigned.addEventListener('click', async () => {
    if (state.contextSessionId) { await moveSession(state.contextSessionId, ''); }
    hideAllMenus();
  });
  dom.moveMenu.appendChild(unassigned);

  function addGroupToMenu(group, depth) {
    const item = document.createElement('div');
    item.className = 'context-item'; item.dataset.groupId = group.id;
    item.style.paddingLeft = (14 + depth * 16) + 'px';
    item.textContent = '📁 ' + group.name;
    item.addEventListener('click', async () => {
      if (state.contextSessionId) { await moveSession(state.contextSessionId, group.id); }
      hideAllMenus();
    });
    dom.moveMenu.appendChild(item);
    // Add children
    state.groups.filter(g => g.parentId === group.id).forEach(child => addGroupToMenu(child, depth + 1));
  }

  state.groups.filter(g => !g.parentId).forEach(g => addGroupToMenu(g, 0));
}

function hideAllMenus() {
  dom.contextMenu.classList.add('hidden');
  dom.groupContextMenu.classList.add('hidden');
  dom.moveMenu.classList.add('hidden');
  var tcm = $('#tab-context-menu');
  if (tcm) tcm.classList.add('hidden');
  state.contextSessionId = null; state.contextGroupId = null;
}

// ===== Tab Context Menu =====
function showTabContextMenu(x, y, tab) {
  hideAllMenus();
  var menu = $('#tab-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'tab-context-menu';
    menu.className = 'tab-context-menu hidden';
    document.body.appendChild(menu);
  }
  menu.innerHTML = '';
  
  // Reconnect option (only if disconnected)
  var reconnectItem = document.createElement('div');
  reconnectItem.className = 'tab-context-item' + (tab.connected ? ' disabled' : '');
  reconnectItem.textContent = '🔄 重新连接';
  if (!tab.connected) {
    reconnectItem.addEventListener('click', function() {
      hideAllMenus();
      // Trigger reconnection
      connectToDevice({
        host: tab.host, port: tab.port, username: tab.username,
        password: tab.password, protocol: tab.protocol, name: tab.title,
      });
    });
  }
  menu.appendChild(reconnectItem);
  
  // Close tab option
  var closeItem = document.createElement('div');
  closeItem.className = 'tab-context-item';
  closeItem.textContent = '✕ 关闭标签';
  closeItem.addEventListener('click', function() {
    hideAllMenus();
    closeTab(tab.id);
  });
  menu.appendChild(closeItem);
  
  menu.classList.remove('hidden');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

// ===== Modals =====
function showConnModal(editId) {
  pauseAllGuacKeyboards();
  if (editId) {
    // Reload sessions to ensure we have latest data
    loadSessions().then(() => {
      const s = state.sessions.find(x => x.id === editId);
      if (s) {
        dom.modalTitle.textContent = '编辑连接';
        $('#conn-name').value = s.name || ''; $('#conn-protocol').value = s.protocol || 'ssh';
        $('#conn-host').value = s.host || ''; $('#conn-port').value = s.port || '';
        $('#conn-username').value = s.username || ''; $('#conn-password').value = s.password || '';
        $('#conn-privatekey').value = s.privateKey || ''; $('#conn-description').value = s.description || '';
        $('#conn-group').value = s.group || ''; $('#conn-save').checked = true;
        dom.connModal.dataset.editId = editId;
        updateProtocolUI();
        dom.connModal.classList.remove('hidden');
      } else {
        alert('会话未找到，请刷新页面');
        return;
      }
    });
    return;
  } else {
    dom.modalTitle.textContent = '新建连接'; resetConnForm(); delete dom.connModal.dataset.editId;
  }
  dom.connModal.classList.remove('hidden');
  setTimeout(() => $('#conn-host')?.focus(), 100);
}

function resetConnForm() {
  $('#conn-name').value = ''; $('#conn-protocol').value = 'ssh'; $('#conn-host').value = '';
  $('#conn-port').value = '22'; $('#conn-username').value = ''; $('#conn-password').value = '';
  $('#conn-privatekey').value = ''; $('#conn-description').value = ''; $('#conn-group').value = '';
  $('#conn-save').checked = true; $('#auth-type').value = 'password';
  $('#password-group').classList.remove('hidden'); $('#key-group').classList.add('hidden');
  updateProtocolUI();
}

function hideConnModal() {
  if (dom.quickModal.classList.contains('hidden') && dom.groupModal.classList.contains('hidden')) resumeAllGuacKeyboards(); dom.connModal.classList.add('hidden'); }

function showQuickModal() {
  pauseAllGuacKeyboards();
  $('#quick-host').value = ''; $('#quick-password').value = ''; $('#quick-protocol').value = 'ssh';
  dom.quickModal.classList.remove('hidden');
  setTimeout(() => $('#quick-host')?.focus(), 100);
}

function hideQuickModal() {
  if (dom.connModal.classList.contains('hidden') && dom.groupModal.classList.contains('hidden')) resumeAllGuacKeyboards(); dom.quickModal.classList.add('hidden'); }

function showGroupModal(editId, parentId) {
  pauseAllGuacKeyboards();
  if (editId) {
    const g = state.groups.find(x => x.id === editId);
    $('#group-name').value = g ? g.name : '';
    dom.groupModal.dataset.editId = editId;
    delete dom.groupModal.dataset.parentId;
    $('#group-modal-title').textContent = '重命名分组';
  } else {
    $('#group-name').value = '';
    delete dom.groupModal.dataset.editId;
    dom.groupModal.dataset.parentId = parentId || '';
    $('#group-modal-title').textContent = parentId ? '新建子分组' : '新建分组';
  }
  dom.groupModal.classList.remove('hidden');
  setTimeout(() => $('#group-name')?.focus(), 100);
}
function hideGroupModal() {
  if (dom.connModal.classList.contains('hidden') && dom.quickModal.classList.contains('hidden')) resumeAllGuacKeyboards(); dom.groupModal.classList.add('hidden'); }


// ===== SFTP File Transfer =====
var sftpState = {
  tabId: null, host: '', port: 22, username: '', password: '', privateKey: '',
  currentPath: '/', items: [], selected: null, _reqId: 0,
};

function openSftpPanel(session) {
  sftpState.tabId = session.tabId || null;
  sftpState.host = session.host;
  sftpState.port = session.port || 22;
  sftpState.username = session.username;
  sftpState.password = session.password || '';
  sftpState.privateKey = session.privateKey || '';
  sftpState.currentPath = '/';
  sftpState._reqId = Date.now();
  
  $('#sftp-modal-title').textContent = '📁 文件传输 - ' + session.username + '@' + session.host;
  $('#sftp-items').innerHTML = '<div class="sftp-empty">⏳ 正在连接...</div>';
  $('#sftp-status').textContent = '';
  $('#sftp-path').value = '/';
  $('#sftp-modal').classList.remove('hidden');
  
  if (!sftpState.tabId) {
    $('#sftp-status').textContent = '请先连接SSH终端';
    $('#sftp-items').innerHTML = '<div class="sftp-empty">❌ 请先打开SSH终端连接</div>';
    return;
  }
  sftpListDir('/');
}

function hideSftpModal() {
  $('#sftp-modal').classList.add('hidden');
}

function sftpListDir(dirPath) {
  $('#sftp-status').textContent = '加载中...';
  sftpState.currentPath = dirPath;
  $('#sftp-path').value = dirPath;
  sftpState._pendingList = dirPath;
  sftpState._reqId = Date.now();
  sendWS({ type: 'sftp-list', tabId: sftpState.tabId, path: dirPath, _reqId: sftpState._reqId });
}

function sftpDownload(fileName) {
  var filePath = sftpJoinPath(sftpState.currentPath, fileName);
  sendWS({ type: 'sftp-download', tabId: sftpState.tabId, path: filePath });
  $('#sftp-status').textContent = '下载中...';
}

function sftpRenderItems(items) {
  var container = $('#sftp-items');
  container.innerHTML = '';
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="sftp-empty">📭 空目录</div>';
    return;
  }
  items.forEach(function(item) {
    var row = document.createElement('div');
    row.className = 'sftp-item';
    var isDir = item.type === 'd';
    var isLink = item.type === 'l';
    var isExec = !isDir && !isLink && (item.mode & 0o111);
    var icon = isDir ? '📁' : (isLink ? '🔗' : (isExec ? '⚡' : '📄'));
    var itemClass = isDir ? ' dir' : (isLink ? ' link' : (isExec ? ' exec' : ''));
    var sizeText = isDir ? '' : formatFileSize(item.size);
    row.innerHTML = '<span class="sftp-icon">' + icon + '</span>' +
      '<span class="sftp-name' + itemClass + '">' + escapeHtml(item.name) + '</span>' +
      '<span class="sftp-size">' + sizeText + '</span>' +
      '<span class="sftp-mtime"></span>';
    row.addEventListener('click', function() {
      $$('.sftp-item').forEach(function(el) { el.classList.remove('selected'); });
      row.classList.add('selected');
      sftpState.selected = item;
    });
    row.addEventListener('dblclick', function() {
      if (isDir) sftpListDir(sftpJoinPath(sftpState.currentPath, item.name));
      else sftpDownload(item.name);
    });
    row.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      $$('.sftp-item').forEach(function(el) { el.classList.remove('selected'); });
      row.classList.add('selected');
      sftpState.selected = item;
      showSftpContextMenu(e.clientX, e.clientY, item);
    });
    container.appendChild(row);
  });
}


function showSftpContextMenu(x, y, item) {
  hideAllMenus();
  var menu = $('#sftp-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'sftp-context-menu';
    menu.className = 'context-menu hidden';
    document.body.appendChild(menu);
  }
  var isDir = item.type === 'd' || item.type === 'l';
  menu.innerHTML = '';
  
  if (!isDir) {
    var dl = document.createElement('div');
    dl.className = 'context-item';
    dl.textContent = '📥 下载';
    dl.addEventListener('click', function() { hideAllMenus(); sftpDownload(item.name); });
    menu.appendChild(dl);
  }
  
  menu.classList.remove('hidden');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  setTimeout(function() {
    var close = function(e) { if (!menu.contains(e.target)) { menu.classList.add('hidden'); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 10);
}

function sftpJoinPath(base, name) {
  if (base === '/') return '/' + name;
  return base.replace(/\/$/, '') + '/' + name;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function downloadBlob(blob, fileName) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click();
  setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  $('#sftp-status').textContent = '下载完成';
}


function updateProtocolUI() {
  const proto = $('#conn-protocol').value;
  const authFields = $('#ssh-auth-fields');
  const isTerminal = proto === 'ssh' || proto === 'telnet';
  const isDesktop = proto === 'vnc' || proto === 'rdp';

  authFields.style.display = (proto === 'telnet') ? 'none' : '';
  // Update default ports
  const portMap = { ssh: 22, telnet: 23, vnc: 5900, rdp: 3389 };
  if ($('#conn-port').value === String(portMap.ssh) && proto !== 'ssh') $('#conn-port').value = portMap[proto] || 22;
  else if ($('#conn-port').value === String(portMap.telnet) && proto !== 'telnet') $('#conn-port').value = portMap[proto] || 22;
  else if ($('#conn-port').value === String(portMap.vnc) && proto !== 'vnc') $('#conn-port').value = portMap[proto] || 22;
  else if ($('#conn-port').value === String(portMap.rdp) && proto !== 'rdp') $('#conn-port').value = portMap[proto] || 22;
}

function updateAuthFields() {
  const isKey = $('#auth-type').value === 'key';
  $('#password-group').classList.toggle('hidden', isKey);
  $('#key-group').classList.toggle('hidden', !isKey);
}

function submitConnForm() {
  const proto = $('#conn-protocol').value;
  const host = $('#conn-host').value.trim();
  const port = parseInt($('#conn-port').value) || (proto === 'ssh' ? 22 : proto === 'telnet' ? 23 : proto === 'vnc' ? 5900 : 3389);
  const username = $('#conn-username').value.trim();
  const password = $('#conn-password').value;
  const privateKey = $('#conn-privatekey').value.trim();
  const name = $('#conn-name').value.trim() || host;
  const description = $('#conn-description').value.trim();
  const group = $('#conn-group').value;
  const shouldSave = $('#conn-save').checked;
  const editId = dom.connModal.dataset.editId;

  if (!host) { alert('请填写主机地址'); return; }

  const config = { name, host, port, username: username || '', password, privateKey, protocol: proto, group, description };

  if (editId) { updateSession(editId, config); } else if (shouldSave) { saveSession(config); }

  hideConnModal();
  connectToDevice(config);
}

function submitQuickForm() {
  const proto = $('#quick-protocol').value;
  const hostStr = $('#quick-host').value.trim();
  const password = $('#quick-password').value;
  if (!hostStr) { alert('请输入主机地址'); return; }

  let username = (proto === 'ssh') ? 'root' : '';
  let host = hostStr;
  let port = proto === 'ssh' ? 22 : proto === 'telnet' ? 23 : proto === 'vnc' ? 5900 : 3389;

  const atIdx = hostStr.lastIndexOf('@');
  if (atIdx > 0) { username = hostStr.substring(0, atIdx); host = hostStr.substring(atIdx + 1); }

  const colons = (host.match(/:/g) || []).length;
  if (colons === 1) { const lc = host.lastIndexOf(':'); port = parseInt(host.substring(lc + 1)) || port; host = host.substring(0, lc); }
  else if (colons > 1) { const m = host.match(/^\[(.+)\]:(\d+)$/); if (m) { host = m[1]; port = parseInt(m[2]) || port; } }

  hideQuickModal();
  connectToDevice({ host, port, username, password, protocol: proto });
}

function submitGroupForm() {
  const name = $('#group-name').value.trim();
  if (!name) { alert('请输入分组名称'); return; }
  const editId = dom.groupModal.dataset.editId;
  if (editId) { updateGroup(editId, name); } else { saveGroup(name, dom.groupModal.dataset.parentId || ''); }
  hideGroupModal();
}

// ===== Utility =====
function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

// ===== Sidebar Resize =====
let isResizing = false;
dom.resizeHandle.addEventListener('mousedown', () => { isResizing = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
document.addEventListener('mousemove', (e) => { if (!isResizing) return; const w = e.clientX; if (w >= 150 && w <= 400) dom.sidebar.style.width = w + 'px'; });
document.addEventListener('mouseup', () => { if (isResizing) { isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; } });

// ===== Event Listeners =====
$('#btn-new-conn').addEventListener('click', () => showConnModal());
$('#welcome-new-conn')?.addEventListener('click', () => showConnModal());
$('#welcome-quick-connect')?.addEventListener('click', () => showQuickModal());
$('#btn-add-group').addEventListener('click', () => showGroupModal());
$('#btn-refresh-sessions').addEventListener('click', loadAll);

$$('.modal-close').forEach(b => b.addEventListener('click', () => { hideConnModal(); hideQuickModal(); hideGroupModal(); hideSftpModal(); }));
$$('.modal-overlay').forEach(o => o.addEventListener('click', () => { hideConnModal(); hideQuickModal(); hideGroupModal(); hideSftpModal(); }));

$('#conn-protocol').addEventListener('change', updateProtocolUI);
$('#auth-type').addEventListener('change', updateAuthFields);

$('#btn-conn-submit').addEventListener('click', submitConnForm);
$('#btn-conn-cancel').addEventListener('click', hideConnModal);
$('#btn-quick-submit').addEventListener('click', submitQuickForm);
$('#btn-quick-cancel').addEventListener('click', hideQuickModal);
$('#btn-group-submit').addEventListener('click', submitGroupForm);
$('#group-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitGroupForm(); } });
$('#btn-group-cancel').addEventListener('click', hideGroupModal);

// SFTP toolbar events
$('#sftp-btn-up').addEventListener('click', function() {
  var p = sftpState.currentPath;
  if (p === '/') return;
  sftpListDir(p.substring(0, p.lastIndexOf('/')) || '/');
});
$('#sftp-btn-go').addEventListener('click', function() {
  sftpListDir($('#sftp-path').value || '/');
});
$('#sftp-path').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sftpListDir($('#sftp-path').value || '/');
});
$('#sftp-btn-refresh').addEventListener('click', function() {
  sftpListDir(sftpState.currentPath);
});
$('#sftp-upload-input').addEventListener('change', function() {
  var file = this.files[0];
  if (!file) return;
  if (!sftpState.tabId) { alert('请先连接SSH终端'); this.value = ''; return; }
  
  $('#sftp-status').textContent = '读取文件中...';
  var totalSize = file.size;
  $('#sftp-status').textContent = '读取中 0%...';
  var reader = new FileReader();
  reader.onprogress = function(e) {
    if (e.lengthComputable) {
      $('#sftp-status').textContent = '读取中 ' + Math.round(e.loaded/e.total*100) + '%...';
    }
  };
  reader.onload = function() {
    var base64 = reader.result.split(',')[1];
    $('#sftp-status').textContent = '上传中...';
    sftpState._uploadPath = sftpJoinPath(sftpState.currentPath, file.name);
    sendWS({ type: 'sftp-upload', tabId: sftpState.tabId, path: sftpState._uploadPath, data: base64 });
  };
  reader.onerror = function() { $('#sftp-status').textContent = '读取文件失败'; };
  reader.readAsDataURL(file);
  this.value = '';
});

// Context menu actions
dom.contextMenu.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action || !state.contextSessionId) return;
  const session = state.sessions.find(s => s.id === state.contextSessionId);
  if (!session) return;

  if (action === 'edit') { showConnModal(state.contextSessionId); }
  else if (action === 'duplicate') { connectToDevice({ host: session.host, port: session.port, username: session.username, password: session.password, privateKey: session.privateKey, protocol: session.protocol, name: session.name + ' (副本)' }); }
  else if (action === 'move') { showMoveMenu(parseInt(dom.contextMenu.style.left), parseInt(dom.contextMenu.style.top) + 30); return; }
  else if (action === 'delete') { if (confirm('确定删除 "' + session.name + '"？')) deleteSession(state.contextSessionId); }
  hideAllMenus();
});

dom.groupContextMenu.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action || !state.contextGroupId) return;
  if (action === 'rename-group') { showGroupModal(state.contextGroupId); }
  else if (action === 'new-subgroup') { showGroupModal(null, state.contextGroupId); }
  else if (action === 'delete-group') { if (confirm('确定删除此分组？会话将移至上级分组。')) deleteGroup(state.contextGroupId); }
  hideAllMenus();
});

dom.moveMenu.addEventListener('click', () => { hideAllMenus(); });

document.addEventListener('click', (e) => {
  if (!dom.contextMenu.contains(e.target) && !dom.groupContextMenu.contains(e.target) && !dom.moveMenu.contains(e.target)) hideAllMenus();
});

const welcomeTabEl = document.querySelector('.tab[data-tabid="welcome"]');
if (welcomeTabEl) welcomeTabEl.addEventListener('click', () => switchTab('welcome'));

$('#btn-logout')?.addEventListener('click', async () => {
  try { await apiFetch('/api/logout', { method: 'POST' }); } catch(e) {}
  localStorage.removeItem('st_token');
  location.href = '/login.html';
});

// Keyboard
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'N') { e.preventDefault(); showConnModal(); }
  if (e.ctrlKey && e.shiftKey && e.key === 'Q') { e.preventDefault(); showQuickModal(); }
  if (e.ctrlKey && e.key === 'w') { e.preventDefault(); closeActiveTab(); }
  if (e.key === 'Escape') { hideConnModal(); hideQuickModal(); hideGroupModal(); hideSftpModal(); hideAllMenus(); }
});

// ===== Auth =====
function getToken() { return localStorage.getItem('st_token') || ''; }

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, 'Authorization': 'Bearer ' + getToken() }
  });
  if (res.status === 401) { localStorage.removeItem('st_token'); location.href = '/login.html'; throw new Error('Unauthorized'); }
  return res;
}

// ===== Init =====
if (!getToken()) { location.href = '/login.html'; } else {
  connectWebSocket();
  loadAll();
}
