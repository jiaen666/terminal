const express = require('express');
const http = require('http');
const net = require('net');
const url = require('url');
const crypto = require('crypto');
// Polyfill crypto.createCredentials for Node.js 22+ (required by node-rdpjs)
if (!crypto.createCredentials) {
  const tls = require('tls');
  crypto.createCredentials = function(options) {
    return tls.createSecureContext(options || {});
  };
}

const { WebSocketServer } = require('ws');
const { Client: SSHClient } = require('ssh2');
const rdp = require('node-rdpjs');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin123';
const RDP_TUNNEL_PORT_START = parseInt(process.env.RDP_TUNNEL_PORT_START) || 13500;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Token store: token -> expireTime
const tokens = new Map();

// ===== Static files =====
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== Auth =====
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !tokens.has(token) || tokens.get(token) < Date.now()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  tokens.set(token, Date.now() + 24 * 60 * 60 * 1000);
  next();
}

function verifyToken(token) {
  return tokens.has(token) && tokens.get(token) > Date.now();
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== AUTH_PASSWORD) return res.status(401).json({ error: '密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, Date.now() + 24 * 60 * 60 * 1000);
  res.json({ token });
});

app.post('/api/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  tokens.delete(token);
  res.json({ success: true });
});

app.get('/api/check-auth', authMiddleware, (req, res) => {
  res.json({ authenticated: true });
});

// Protect all session/group APIs
app.use('/api/sessions', authMiddleware);
app.use('/api/groups', authMiddleware);

// ===== Session Storage =====
let savedSessions = [];
let savedGroups = [];

try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    savedSessions = data.sessions || (Array.isArray(data) ? data : []);
    savedGroups = data.groups || [];
    savedSessions.forEach(s => { if (!s.protocol) s.protocol = 'ssh'; if (!s.group) s.group = ''; });
    savedGroups.forEach(g => { if (!g.parentId) g.parentId = ''; });
  }
} catch (e) { savedSessions = []; savedGroups = []; }

function saveToDisk() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: savedSessions, groups: savedGroups }, null, 2));
}

// Migration: if data dir is empty, try loading from old path
if (savedSessions.length === 0 && savedGroups.length <= 1) {
  const oldFile = path.join(__dirname, 'sessions.json');
  if (fs.existsSync(oldFile) && oldFile !== SESSIONS_FILE) {
    try {
      const oldData = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
      if (oldData.sessions?.length > 0) {
        savedSessions = oldData.sessions;
        savedGroups = oldData.groups || savedGroups;
        console.log('Migrated ' + savedSessions.length + ' sessions from old location');
      }
    } catch (e) { console.error('Migration failed:', e.message); }
  }
}
if (savedGroups.length === 0) {
  savedGroups.push({ id: 'default', name: '默认分组', order: 0, parentId: '' });
}
saveToDisk();

// ===== REST: Sessions =====
app.get('/api/sessions', (req, res) => {
  res.json(savedSessions.map(s => ({
    id: s.id, name: s.name, host: s.host, port: s.port,
    username: s.username, password: s.password || '', privateKey: s.privateKey || '',
    protocol: s.protocol || 'ssh', group: s.group || '', description: s.description || '',
  })));
});

app.post('/api/sessions', (req, res) => {
  const b = req.body;
  if (!b.name || !b.host) return res.status(400).json({ error: 'name and host required' });
  const proto = b.protocol || 'ssh';
  const defaultPort = proto === 'telnet' ? 23 : proto === 'vnc' ? 5900 : proto === 'rdp' ? 3389 : 22;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const session = { id, name: b.name, host: b.host, port: b.port || defaultPort,
    username: b.username || '', password: b.password || '', privateKey: b.privateKey || '',
    protocol: proto, group: b.group || '', description: b.description || '' };
  savedSessions.push(session); saveToDisk();
  res.json({ id, name: session.name, host: session.host, port: session.port,
    username: session.username, protocol: session.protocol, group: session.group, description: session.description });
});

app.put('/api/sessions/:id', (req, res) => {
  const idx = savedSessions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  ['name','host','port','username','password','privateKey','protocol','group','description']
    .forEach(f => { if (req.body[f] !== undefined) savedSessions[idx][f] = req.body[f]; });
  saveToDisk(); res.json({ success: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  const idx = savedSessions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  savedSessions.splice(idx, 1); saveToDisk(); res.json({ success: true });
});

// ===== REST: Groups =====
app.get('/api/groups', (req, res) => { res.json(savedGroups); });

app.post('/api/groups', (req, res) => {
  const { name, parentId } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'g_' + Date.now().toString(36);
  const g = { id, name, parentId: parentId || '', order: savedGroups.length };
  savedGroups.push(g); saveToDisk();
  res.json(g);
});

app.put('/api/groups/:id', (req, res) => {
  const idx = savedGroups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) savedGroups[idx].name = req.body.name;
  if (req.body.parentId !== undefined) savedGroups[idx].parentId = req.body.parentId;
  saveToDisk(); res.json({ success: true });
});

app.delete('/api/groups/:id', (req, res) => {
  const delId = req.params.id;
  const idx = savedGroups.findIndex(g => g.id === delId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const parentId = savedGroups[idx].parentId || '';
  // Reassign child groups and sessions to parent
  savedGroups.filter(g => g.parentId === delId).forEach(g => { g.parentId = parentId; });
  savedSessions.forEach(s => { if (s.group === delId) s.group = parentId; });
  savedGroups.splice(idx, 1); saveToDisk(); res.json({ success: true });
});

// ===== Active Connections (keyed by tabId) =====
const activeConnections = new Map(); // tabId -> { type, client, stream, ws }

// ===== HTTP Upgrade: WebSocket =====
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  if (pathname === '/ws/vnc') {
    handleVNCUpgrade(request, socket, head);
  } else if (pathname === '/ws/guac') {
    handleGuacUpgrade(request, socket, head);
  } else {
    const query = url.parse(request.url, true).query;
    if (!verifyToken(query.token || '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  }
});

// ===== Guacamole WebSocket Proxy (for RDP via embedded guacd) =====
const GuacdClient = require('guacamole-lite/lib/GuacdClient');
const GuacamoleParser = require('guacamole-lite/lib/vendor/GuacamoleParser.js');
const { Logger } = require('guacamole-lite/lib/Logger');

// Patch GuacdClient to set TCP_NODELAY (fixes Nagle's algorithm causing handshake timeout)
class PatchedGuacdClient extends GuacdClient {
  constructor(...args) {
    super(...args);
    if (this.guacdConnection && this.guacdConnection.setNoDelay) {
      this.guacdConnection.setNoDelay(true);
    }
  }
}

function handleGuacUpgrade(request, socket, head) {
  const query = url.parse(request.url, true).query;
  const host = query.host;
  const protocol = query.protocol || 'rdp';
  const port = parseInt(query.port) || (protocol === 'vnc' ? 5900 : 3389);
  const username = query.username || '';
  const password = query.password || '';
  const domain = query.domain || '';
  const width = parseInt(query.width) || 1280;
  const height = parseInt(query.height) || 720;
  const dpi = parseInt(query.dpi) || 96;

  if (!host) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const security = query.security || process.env.RDP_SECURITY || 'any';
  console.log(`Guac ${protocol.toUpperCase()} connecting to ${host}:${port}${username ? ' as ' + username : ''}`);

  const wsServer = new WebSocketServer({ noServer: true });
  wsServer.handleUpgrade(request, socket, head, (ws) => {
    const guacdHost = process.env.GUACD_HOST || '127.0.0.1';
    const bridgeHost = process.env.BRIDGE_HOST || guacdHost;
    
    // Build connection params based on protocol
    const params = {
      hostname: host,
      port: String(port),
      width: width,
      height: height,
      dpi: dpi,
      timezone: 'Asia/Shanghai',
    };
    
    if (protocol === 'vnc') {
      console.log('VNC connecting to ' + host + ':' + port);
      // Use guacd native VNC client directly (no bridge needed)
      connectGuacVNC(ws, guacdHost, host, port, password, width, height, dpi);
      return;
    } else {
      // RDP params
      Object.assign(params, {
        username: username,
        password: password,
        domain: domain,
        security: query.security || 'nla',
        'ignore-cert': 'true',
        'disable-auth': 'false',
                'color-depth': '16',
        'enable-wallpaper': 'true',
        'enable-theming': 'true',
        'enable-font-smoothing': 'true',
        'enable-full-window-drag': 'false',
        'enable-desktop-composition': 'true',
        'enable-menu-animations': 'false',
        'disable-bitmap-caching': 'false',
        'disable-offscreen-caching': 'false',
        'disable-glyph-caching': 'false',
        'force-lossless': 'false',
        'server-layout': 'en-us-qwerty',
        'client-name': 'SuperTerminal',
      });
    }
    
    // Always provide image support for display data
    params.image = ['image/png', 'image/jpeg'];
    params.video = null;
    params.audio = protocol === 'vnc' ? null : ['audio/L16'];
    



    var gc = new PatchedGuacdClient(
      { host: guacdHost, port: 4822 },
      protocol,
      params,
      new Logger('ERRORS')
    );

    gc.on('open', () => console.log('Guac ' + protocol.toUpperCase() + ' opened:', host));
    
    gc.on('data', (instruction) => {
      // Filter out TLS/cert-bypass errors (empty message + status 0)
      // These occur when guacd's cert error has been suppressed via binary patch
      if (instruction.indexOf('5.error,0.,1.0;') >= 0 ||
          instruction.indexOf('5.error,1.,1.0;') >= 0) {
        console.log('Suppressed cert-bypass error, connection continues');
        return;
      }
      if (ws.readyState === 1) ws.send(instruction);
    });

    gc.on('error', (err) => {
      console.error('Guac error:', err.message);
      if (ws.readyState === 1) {
        ws.send(GuacamoleParser.toInstruction(['error', err.message, '']));
        ws.close();
      }
    });

    gc.on('close', (err) => {
      if (ws.readyState === 1) {
        // Send disconnect notification so client can show reconnect UI
        const msg = err ? err.message || 'Connection closed' : 'Connection closed';
        ws.send(GuacamoleParser.toInstruction(['error', msg, GuacamoleParser.STATUS_SESSION_CLOSED + '']));
        // Don't close WebSocket - let client decide to reconnect
      }
    });

    ws.on('message', (data) => {
      if (gc) gc.send(data.toString(), true);
    });

    ws.on('close', () => {
      if (gc) { gc.close(); gc = null; }
    });

    ws.on('error', () => {
      if (gc) { gc.close(); gc = null; }
    });

  });
}

// ===== Helper: Connect VNC via guacd =====
function connectGuacVNC(ws, guacdHost, host, port, password, width, height, dpi) {
  const vncParams = {
    hostname: host,
    port: String(port),
    password: password || '',
    width: width || 1280,
    height: height || 720,
    dpi: dpi || 96,
    'color-depth': '16',
    'swap-red-blue': 'false',
    'read-only': 'false',
    'cursor': 'local',
    'autoretry': 'true',
    'encodings': 'hextile zlib copyrect rre raw',
      };
  vncParams.image = ['image/png', 'image/jpeg'];
  vncParams.video = null;
  vncParams.audio = null;

  console.log('VNC guac connecting to ' + host + ':' + port);
  
  var gc = new PatchedGuacdClient(
    { host: guacdHost, port: 4822 },
    'vnc',
    vncParams,
    new Logger('VERBOSE')
  );

  gc.on('open', () => console.log('Guac VNC opened:', host));
  
  gc.on('data', (instruction) => {
    if (ws.readyState === 1) ws.send(instruction);
  });

  gc.on('error', (err) => {
    console.error('Guac VNC error:', err.message, err.stack);
    if (ws.readyState === 1) {
      ws.send(GuacamoleParser.toInstruction(['error', 'VNC: ' + (err.message || 'unknown error'), '515']));
      ws.close();
    }
  });

  gc.on('close', () => {
    if (ws.readyState === 1) {
      ws.send(GuacamoleParser.toInstruction(['error', 'VNC connection closed', '515']));
    }
  });

  ws.on('message', (data) => {
    if (gc) gc.send(data.toString(), true);
  });

  ws.on('close', () => {
    if (gc) { gc.close(); gc = null; }
  });

  ws.on('error', () => {
    if (gc) { gc.close(); gc = null; }
  });
}


// ===== VNC WebSocket Proxy =====
function handleVNCUpgrade(request, socket, head) {
  const query = url.parse(request.url, true).query;
  const host = query.host, vport = parseInt(query.port) || 5900;
  if (!host) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  console.log(`VNC proxy connecting to ${host}:${vport}`);
  const vncSocket = new net.Socket(); let ws = null;
  vncSocket.connect(vport, host, () => {
    const wsServer = new WebSocketServer({ noServer: true });
    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      ws = websocket;
      ws.on('message', (d) => { if (vncSocket.writable) vncSocket.write(d); });
      ws.on('close', () => { try { vncSocket.destroy(); } catch(e) {} });
      ws.on('error', () => { try { vncSocket.destroy(); } catch(e) {} });
    });
  });
  vncSocket.on('data', (d) => { if (ws?.readyState === 1) ws.send(d); });
  vncSocket.on('error', () => { try { ws?.close(); socket.destroy(); } catch(e) {} });
  vncSocket.on('close', () => { try { ws?.close(); } catch(e) {} });
  setTimeout(() => { if (!ws && !vncSocket.destroyed) { try { vncSocket.destroy(); socket.destroy(); } catch(e) {} } }, 15000);
}

// ===== Main WebSocket (for SSH, Telnet, and terminal input/output) =====
let wsIdCounter = 0;
wss.on('connection', (ws) => {
  const wsId = ++wsIdCounter;
  console.log(`Main WS connected #${wsId}`);
  
  // Ping/pong keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  ws.on('message', (msg) => {
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }
    switch (data.type) {
      case 'ssh-connect': handleSSH(ws, data); break;
      case 'telnet-connect': handleTelnet(ws, data); break;
      case 'input': case 'ssh-input': sendInput(ws, data); break;
      case 'resize': case 'ssh-resize': sendResize(ws, data); break;
      case 'disconnect': case 'ssh-disconnect': disconnect(ws, data); break;
      case 'rdp-connect': handleRDPConnect(ws, data); break;
      case 'rdp-pointer': handleRDPPointer(data); break;
      case 'rdp-key': handleRDPKey(data); break;
      case 'sftp-list': handleSftpList(ws, data); break;
      case 'sftp-download': handleSftpDownload(ws, data); break;
      case 'sftp-upload': handleSftpUpload(ws, data); break;
    }
  });
  
  ws.on('close', () => {
    console.log(`Main WS #${wsId} closed`);
    // Graceful cleanup: mark connections as orphaned, don't kill them
    for (const [tabId, conn] of activeConnections) {
      if (conn.ws === ws) {
        conn.orphaned = true;
        // Clean up after 30 seconds if not reclaimed
        const connRef = conn;
        conn._orphanTimeout = setTimeout(() => {
          if (connRef.orphaned) {
            try { connRef.stream?.end(); } catch {}
            try { connRef.client?.end(); } catch {}
            try { connRef.client?.destroy?.(); } catch {}
            try { connRef.client?.close?.(); } catch {}
            activeConnections.delete(tabId);
            console.log(`Orphan cleanup: ${tabId}`);
          }
        }, 30000);
      }
    }
  });
  
  ws.on('error', () => ws.close());
});

// Keepalive interval - ping all clients every 10 seconds
const keepaliveInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

wss.on('close', () => clearInterval(keepaliveInterval));

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function sendInput(ws, data) {
  const c = activeConnections.get(data.tabId);
  if (c?.stream?.writable) c.stream.write(data.data);
}

function sendResize(ws, data) {
  const c = activeConnections.get(data.tabId);
  if (c?.stream && c.type === 'ssh') {
    try { c.stream.setWindow(data.rows, data.cols, 0, 0); } catch {}
  }
}

function disconnect(ws, data) {
  if (data?.tabId) {
    // Disconnect specific tab
    const conn = activeConnections.get(data.tabId);
    if (conn?.ws === ws) {
      if (conn._orphanTimeout) clearTimeout(conn._orphanTimeout);
      try { conn.stream?.end(); } catch {}
      try { conn.client?.end(); } catch {}
      try { conn.client?.destroy?.(); } catch {}
      try { conn.client?.close?.(); } catch {}
      activeConnections.delete(data.tabId);
    }
  }
}

// ===== RDP (node-rdpjs - native JS, no cert issues) =====
function handleRDPConnect(ws, data) {
  disconnect(ws, { tabId: data.tabId });
  const { host, port, username, password, tabId, width, height } = data;
  if (!host) { send(ws, { type: 'error', tabId, message: 'Host required' }); return; }
  if (!username) { send(ws, { type: 'error', tabId, message: 'RDP需要用户名' }); return; }
  
  console.log('RDP (node-rdpjs) connecting to ' + host + ':' + (port || 3389) + ' as ' + (username || 'Administrator'));
  
  const client = rdp.createClient({
    domain: data.domain || '',
    userName: username || 'Administrator',
    password: password || '',
    enablePerf: true,
    autoLogin: true,
    decompress: true,
    screen: { width: width || 1280, height: height || 720 },
    locale: 'en',
    logLevel: 'WARN',
  });
  
  client.on('connect', () => {
    activeConnections.set(tabId, { type: 'rdp', client, stream: null, ws });
    send(ws, { type: 'connected', tabId });
  });
  
  client.on('bitmap', (bm) => {
    send(ws, {
      type: 'rdp-bitmap', tabId,
      destTop: bm.destTop, destLeft: bm.destLeft,
      destBottom: bm.destBottom, destRight: bm.destRight,
      width: bm.width, height: bm.height,
      bitsPerPixel: bm.bitsPerPixel, isCompress: bm.isCompress,
      data: bm.data.toString('base64')
    });
  });
  
  client.on('error', (e) => {
    var msg = e.message || '';
    if (msg.indexOf('NEG_FAILURE') >= 0) msg = 'RDP协议协商失败 - 服务器要求NLA。请在Windows上关闭网络级身份验证';
    else if (msg.indexOf('NLA_NOT_SUPPORTED') >= 0) msg = 'RDP不支持NLA认证';
    else msg = 'RDP: ' + msg;
    send(ws, { type: 'error', tabId, message: msg });
    activeConnections.delete(tabId);
  });
  
  client.on('close', () => {
    send(ws, { type: 'disconnected', tabId, message: 'RDP disconnected' });
    activeConnections.delete(tabId);
  });
  
  client.connect(host, port || 3389);
}

function handleRDPPointer(data) {
  const rc = activeConnections.get(data.tabId);
  if (rc?.client) rc.client.sendPointerEvent(data.x, data.y, data.button || 1, data.isPressed);
}

function handleRDPKey(data) {
  const rc = activeConnections.get(data.tabId);
  if (rc?.client) rc.client.sendKeyEventScancode(data.scancode, data.isPressed);
}


// ===== Telnet =====
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;

function handleTelnet(ws, data) {
  disconnect(ws, { tabId: data.tabId });
  const { host, port, tabId, termCols, termRows } = data;
  if (!host) { send(ws, { type: 'error', tabId, message: 'Host required' }); return; }
  const c = new net.Socket(); let buf = Buffer.alloc(0);
  c.setKeepAlive(true, 10000);
  c.connect(port || 23, host, () => {
    activeConnections.set(tabId, { type: 'telnet', client: c, stream: c, ws });
    send(ws, { type: 'connected', tabId });
    c.write(Buffer.from([IAC, SB, 31, (termCols || 80) >> 8, (termCols || 80) & 0xFF, (termRows || 24) >> 8, (termRows || 24) & 0xFF, IAC, SE]));
  });
  c.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length > 0) {
      const idx = buf.indexOf(IAC);
      if (idx === -1) { send(ws, { type: 'output', tabId, data: buf.toString('binary') }); buf = Buffer.alloc(0); break; }
      if (idx > 0) send(ws, { type: 'output', tabId, data: buf.subarray(0, idx).toString('binary') });
      if (buf.length < idx + 2) break;
      const cmd = buf[idx + 1];
      if (cmd === IAC) { send(ws, { type: 'output', tabId, data: String.fromCharCode(IAC) }); buf = buf.subarray(idx + 2); continue; }
      if (buf.length < idx + 3) break;
      const opt = buf[idx + 2];
      const reply = cmd === WILL ? [IAC, opt === 1 ? DO : DONT, opt]
        : cmd === DO ? [IAC, (opt === 3 || opt === 31 || opt === 24) ? WILL : WONT, opt]
        : cmd === DONT ? [IAC, WONT, opt]
        : cmd === WONT ? [IAC, DONT, opt] : null;
      if (reply) c.write(Buffer.from(reply));
      else if (cmd === SB) { const se = buf.indexOf(SE, idx + 3); if (se === -1) break; buf = buf.subarray(se + 1); continue; }
      buf = buf.subarray(idx + 3);
    }
  });
  c.on('error', (e) => { send(ws, { type: 'error', tabId, message: 'Telnet: ' + e.message }); activeConnections.delete(tabId); });
  c.on('close', () => { send(ws, { type: 'disconnected', tabId, message: 'Telnet disconnected' }); activeConnections.delete(tabId); });
}

// ===== SFTP via Shell (uses existing SSH connection) =====
function handleSftpList(ws, data) {
  var conn = activeConnections.get(data.tabId);
  if (!conn || !conn.client) return send(ws, { type: 'sftp-error', message: 'SSH not active' });
  var dirPath = data.path || '/';
  var cmd = 'ls -lA --time-style=long-iso ' + JSON.stringify(dirPath) + ' 2>/dev/null; echo __SFTP_DONE__';
  conn.client.exec(cmd, function(err, stream) {
    if (err) return send(ws, { type: 'sftp-error', message: 'exec: ' + err.message });
    var buf = '';
    stream.on('data', function(c) {
      buf += c.toString('utf-8');
      if (buf.indexOf('__SFTP_DONE__') >= 0) {
        var lines = buf.split('\n');
        var items = [];
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf('total ') === 0) continue;
          if (line.indexOf('__SFTP_DONE__') >= 0) continue;
          var parts = line.split(/\s+/);
          if (parts.length < 8) continue;
          var perms = parts[0];
          var name = parts.slice(7).join(' ');
          if (name.indexOf(' -> ') >= 0) name = name.split(' -> ')[0];
          items.push({ name: name, type: perms[0] === 'd' ? 'd' : (perms[0] === 'l' ? 'l' : '-'), size: parseInt(parts[4]) || 0, mtime: 0, mode: parseInt(perms, 8) || 0 });
        }
        items.sort(function(a, b) {
          if (a.type === 'd' && b.type !== 'd') return -1;
          if (a.type !== 'd' && b.type === 'd') return 1;
          return a.name.localeCompare(b.name);
        });
        send(ws, { type: 'sftp-items', tabId: data.tabId, path: dirPath, items });
      }
    });
    stream.stderr.on('data', function(c) { send(ws, { type: 'sftp-error', message: c.toString('utf-8').trim() }); });
  });
}

function handleSftpDownload(ws, data) {
  var conn = activeConnections.get(data.tabId);
  if (!conn || !conn.client) return send(ws, { type: 'sftp-error', message: 'SSH not active' });
  var filePath = data.path;
  var fileName = path.basename(filePath);
  var endMarker = '__SFTP_END_' + Date.now() + '__';
  var cmd = 'base64 < ' + JSON.stringify(filePath) + ' 2>/dev/null; echo ' + JSON.stringify(endMarker);
  send(ws, { type: 'sftp-download-start', tabId: data.tabId, fileName: fileName, path: filePath });
  conn.client.exec(cmd, function(err, stream) {
    if (err) return send(ws, { type: 'sftp-error', message: 'exec: ' + err.message });
    var buf = '';
    stream.on('data', function(c) {
      buf += c.toString('utf-8');
      var idx = buf.indexOf(endMarker);
      if (idx >= 0) {
        var b64data = buf.substring(0, idx).replace(/[\r\n]/g, '');
        send(ws, { type: 'sftp-download-chunk', tabId: data.tabId, data: b64data, fileName: fileName });
        send(ws, { type: 'sftp-download-end', tabId: data.tabId });
      }
    });
    stream.stderr.on('data', function(c) { send(ws, { type: 'sftp-error', message: c.toString('utf-8').trim() }); });
  });
}

function handleSftpUpload(ws, data) {
  var conn = activeConnections.get(data.tabId);
  if (!conn || !conn.client) return send(ws, { type: 'sftp-error', message: 'SSH not active' });
  var filePath = data.path;
  var fileData = Buffer.from(data.data, 'base64');
  var endMarker = '__SFTP_UPLOAD_' + Date.now() + '__';
  // Use stdin pipe: base64 decode -> write to file
  var cmd = 'base64 -d > ' + JSON.stringify(filePath) + ' 2>&1; echo ' + JSON.stringify(endMarker);
  conn.client.exec(cmd, function(err, stream) {
    if (err) return send(ws, { type: 'sftp-error', message: 'exec: ' + err.message });
    var buf = '';
    stream.on('data', function(c) {
      buf += c.toString('utf-8');
      if (buf.indexOf(endMarker) >= 0) {
        var errMsg = buf.replace(endMarker, '').trim();
        if (errMsg) send(ws, { type: 'sftp-error', message: errMsg });
        else send(ws, { type: 'sftp-upload-done', tabId: data.tabId });
      }
    });
    stream.stderr.on('data', function(c) { send(ws, { type: 'sftp-error', message: c.toString('utf-8').trim() }); });
    // Write file data to stdin
    stream.write(fileData);
    stream.end();
  });
}


// ===== SSH =====
function handleSSH(ws, data) {
  disconnect(ws, { tabId: data.tabId });
  const { host, port, username, password, privateKey, tabId, termCols, termRows } = data;
  if (!host || !username) { send(ws, { type: 'error', tabId, message: 'Host and username required' }); return; }
  const ssh = new SSHClient();
  activeConnections.set(tabId, { type: 'ssh', client: ssh, stream: null, ws });
  ssh.on('ready', () => {
    ssh.shell({ term: 'xterm-256color', cols: termCols || 80, rows: termRows || 24 }, (err, stream) => {
      if (err) { send(ws, { type: 'error', tabId, message: 'Shell: ' + err.message }); ssh.end(); return; }
      const cn = activeConnections.get(tabId); if (cn) cn.stream = stream;
      send(ws, { type: 'connected', tabId });
      stream.on('data', (c) => send(ws, { type: 'output', tabId, data: c.toString('utf-8') }));
      stream.stderr.on('data', (c) => send(ws, { type: 'output', tabId, data: c.toString('utf-8') }));
      stream.on('close', () => { send(ws, { type: 'disconnected', tabId, message: 'SSH closed' }); ssh.end(); activeConnections.delete(tabId); });
    });
  });
  ssh.on('error', (e) => { send(ws, { type: 'error', tabId, message: e.message }); activeConnections.delete(tabId); });
  ssh.on('close', () => { send(ws, { type: 'disconnected', tabId, message: 'SSH closed' }); activeConnections.delete(tabId); });
  ssh.connect({
    host, port: port || 22, username, readyTimeout: 30000,
    keepaliveInterval: 10000, keepaliveCountMax: 3,
    algorithms: {
      kex: ['ecdh-sha2-nistp256','ecdh-sha2-nistp384','ecdh-sha2-nistp521','diffie-hellman-group-exchange-sha256','diffie-hellman-group14-sha256','diffie-hellman-group16-sha512','diffie-hellman-group18-sha512','diffie-hellman-group14-sha1'],
      cipher: ['aes128-ctr','aes192-ctr','aes256-ctr','aes128-gcm@openssh.com','aes256-gcm@openssh.com','aes256-cbc'],
      serverHostKey: ['ssh-rsa','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521','ssh-ed25519'],
      hmac: ['hmac-sha2-256','hmac-sha2-512','hmac-sha1']
    },
    ...(password ? { password, tryKeyboard: true } : {}),
    ...(privateKey ? { privateKey, passphrase: password || undefined } : {}),
  });
}

// ===== RDP TLS Tunnel Manager =====
const { spawn } = require('child_process');
const bridgeProcesses = new Map();
const tunnelProcesses = new Map();
let nextTunnelPort = RDP_TUNNEL_PORT_START;

function getOrCreateTunnel(rdpHost, rdpPort) {
  const key = rdpHost + ':' + rdpPort;
  if (tunnelProcesses.has(key)) {
    const t = tunnelProcesses.get(key);
    t.refs++;
    return Promise.resolve(t);
  }
  
  return new Promise((resolve) => {
    const localPort = nextTunnelPort++;
    if (nextTunnelPort > RDP_TUNNEL_PORT_START + 1000) nextTunnelPort = RDP_TUNNEL_PORT_START;
    
    const scriptPath = '/tmp/rdp-tunnel-' + localPort + '.sh';
    fs.writeFileSync(scriptPath, 
      '#!/bin/bash\nexec cat | exec openssl s_client -connect ' + rdpHost + ':' + rdpPort + ' -ign_eof -quiet 2>/dev/null',
      { mode: 0o755 });
    
    const socat = spawn('socat', [
      'TCP-LISTEN:' + localPort + ',reuseaddr,fork',
      'EXEC:' + scriptPath + ',nofork'
    ]);
    socat.stderr.on('data', () => {});
    
    const tunnel = { socat, localPort, rdpHost, rdpPort, refs: 1,
      cleanup: () => { tunnelProcesses.delete(key); try { socat.kill(); } catch(e) {} try { fs.unlinkSync(scriptPath); } catch(e) {} }
    };
    tunnelProcesses.set(key, tunnel);
    setTimeout(() => resolve(tunnel), 1500);
  });
}

function releaseTunnel(rdpHost, rdpPort) {
  const key = rdpHost + ':' + rdpPort;
  const t = tunnelProcesses.get(key);
  if (t) {
    t.refs--;
    if (t.refs <= 0) {
      setTimeout(() => {
        if (tunnelProcesses.has(key) && tunnelProcesses.get(key).refs <= 0)
          tunnelProcesses.get(key).cleanup();
      }, 60000);
    }
  }
}

// ===== RDP-to-VNC Bridge API =====
app.post('/api/rdp-bridge', authMiddleware, (req, res) => {
  const { host, port, username, password } = req.body;
  if (!host || !username) return res.status(400).json({ error: 'host and username required' });
  
  const rdpPort = port || 3389;
  const displayNum = 90 + Math.floor(Math.random() * 20);
  const vncPort = 5900 + Math.floor(Math.random() * 100);
  const id = 'bridge_' + Date.now().toString(36);
  
  getOrCreateTunnel(host, rdpPort).then(tunnel => {
    try { spawn('kill', ['-9', '$(cat /tmp/.X' + displayNum + '-lock 2>/dev/null)'], {shell: true}); } catch(e) {}
    try { spawn('rm', ['-f', '/tmp/.X' + displayNum + '-lock', '/tmp/.X11-unix/X' + displayNum]); } catch(e) {}
    
    const xvfb = spawn('Xvfb', [':' + displayNum, '-screen', '0', '1280x720x24']);
    xvfb.stderr.on('data', () => {});
    
    setTimeout(() => {
      const xrdp = spawn('rdesktop', [
        '-e',
        '-u', username,
        '-p', (password || ''),
        '-a', '16',
        '-g', '1280x720',
        '127.0.0.1:' + tunnel.localPort
      ], { env: { ...process.env, DISPLAY: ':' + displayNum } });
      xrdp.stderr.on('data', (d) => console.log('xfreerdp3:', d.toString()));
      xrdp.on('close', () => releaseTunnel(host, rdpPort));
      
      setTimeout(() => {
        const xvnc = spawn('x11vnc', [
          '-display', ':' + displayNum,
          '-rfbport', String(vncPort),
          '-forever', '-shared', '-nopw', '-quiet'
        ]);
        xvnc.stderr.on('data', () => {});
        
        bridgeProcesses.set(id, { xvfb, xrdp, xvnc, displayNum, vncPort, tunnel });
        res.json({ id, vncPort, host: '127.0.0.1' });
      }, 3000);
    }, 1500);
  }).catch(err => res.status(500).json({ error: 'Tunnel error: ' + err.message }));
});

app.delete('/api/rdp-bridge/:id', authMiddleware, (req, res) => {
  const bp = bridgeProcesses.get(req.params.id);
  if (bp) {
    try { bp.xvnc.kill(); } catch(e) {}
    try { bp.xrdp.kill(); } catch(e) {}
    try { bp.xvfb.kill(); } catch(e) {}
    if (bp.tunnel) releaseTunnel(bp.tunnel.rdpHost, bp.tunnel.rdpPort);
    bridgeProcesses.delete(req.params.id);
  }
  res.json({ success: true });
});

server.listen(PORT, () => console.log(`Super Terminal running at http://localhost:${PORT}`));
