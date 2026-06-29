#!/usr/bin/env python3
"""Bridge API: VNC (TCP proxy) and RDP (xfreerdp) bridges."""
import json, sys, subprocess, os, signal, time, socket, threading, select
from http.server import HTTPServer, BaseHTTPRequestHandler

BRIDGES = {}
NEXT_PORT = 6000

def tcp_proxy(local_port, remote_host, remote_port):
    """Simple TCP proxy: forward between local port and remote VNC server."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', local_port))
    server.listen(5)
    server.settimeout(5)
    
    while True:
        try:
            client, addr = server.accept()
        except socket.timeout:
            continue
        except:
            break
        
        try:
            remote = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            remote.settimeout(10)
            remote.connect((remote_host, remote_port))
            remote.settimeout(None)
            client.settimeout(None)
        except Exception as e:
            sys.stderr.write('[vnc-proxy] Failed to connect to %s:%s: %s
' % (remote_host, remote_port, e))
            sys.stderr.flush()
            try: client.close()
            except: pass
            continue
        
        # Bidirectional forwarding
        def forward(src, dst, name):
            try:
                while True:
                    data = src.recv(8192)
                    if not data:
                        break
                    dst.sendall(data)
            except:
                pass
            finally:
                try: dst.close()
                except: pass
        
        t1 = threading.Thread(target=forward, args=(client, remote, 'c2r'), daemon=True)
        t2 = threading.Thread(target=forward, args=(remote, client, 'r2c'), daemon=True)
        t1.start()
        t2.start()


def start_bridge(bridge_type, host, port, password, username=None):
    global NEXT_PORT
    local_port = NEXT_PORT
    NEXT_PORT += 1
    if NEXT_PORT > 6100:
        NEXT_PORT = 6000
    
    # Cleanup old
    old_pid = f'/tmp/{bridge_type}-bridge-{local_port}.pid'
    if os.path.exists(old_pid):
        try:
            with open(old_pid) as f:
                for pid in f.read().strip().split():
                    try: os.kill(int(pid), signal.SIGTERM)
                    except: pass
            os.remove(old_pid)
        except: pass
    
    if bridge_type == 'vnc':
        # Use simple TCP proxy for VNC (much more reliable than TigerVNC->Xvfb->x11vnc)
        proxy_thread = threading.Thread(
            target=tcp_proxy,
            args=(local_port, host, port),
            daemon=True
        )
        proxy_thread.start()
        # Store the thread reference
        pid_file = f'/tmp/vnc-bridge-{local_port}.pid'
        with open(pid_file, 'w') as f:
            f.write(str(os.getpid()))
        BRIDGES[str(local_port)] = {'proc': None, 'type': bridge_type, 'host': host, 'thread': proxy_thread}
    else:  # rdp
        cmd = ['/usr/local/bin/rdp-bridge.sh', host, str(port), username or 'administrator', password or '', str(local_port)]
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        BRIDGES[str(local_port)] = {'proc': proc, 'type': bridge_type, 'host': host}
    
    # Wait for port to be ready
    for i in range(45):
        time.sleep(1)
        try:
            s = socket.socket()
            s.settimeout(1)
            s.connect(('127.0.0.1', local_port))
            s.close()
            return local_port
        except:
            pass
    
    # Timeout
    try:
        if BRIDGES[str(local_port)].get('proc'):
            BRIDGES[str(local_port)]['proc'].kill()
    except: pass
    BRIDGES.pop(str(local_port), None)
    return None

class BridgeHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode()
        try: data = json.loads(body)
        except: self.send_error(400); return
        
        host = data.get('host', '')
        port = data.get('port', 5900)
        password = data.get('password', '')
        username = data.get('username', 'administrator')
        bridge_type = data.get('type', 'vnc')
        
        if not host:
            self.send_error(400, 'host required'); return
        
        sys.stderr.write('[bridge] Starting %s bridge: %s:%s (user=%s)
' % (bridge_type, host, port, username or ''))
        sys.stderr.flush()
        local_port = start_bridge(bridge_type, host, port, password, username)
        sys.stderr.write('[bridge] %s bridge result: port=%s
' % (bridge_type, local_port))
        sys.stderr.flush()
        if local_port:
            result = {'port': local_port, 'host': '127.0.0.1'}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        else:
            self.send_error(500, 'Bridge failed to start')
    
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'status': 'ok', 'bridges': len(BRIDGES)}).encode())
    
    def log_message(self, fmt, *args):
        sys.stderr.write('[bridge] %s - - [%s] %s
' % (self.client_address[0], self.log_date_time_string(), fmt % args))
        sys.stderr.flush()

if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', 5998), BridgeHandler)
    print('Bridge API on port 5998', flush=True)
    server.serve_forever()
