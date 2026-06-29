#!/usr/bin/env python3
"""Bridge API: VNC (tcp-proxy) and RDP (xfreerdp) bridges."""
import json, sys, subprocess, os, signal, time, socket
from http.server import HTTPServer, BaseHTTPRequestHandler

BRIDGES = {}
NEXT_PORT = 6000


def start_bridge(bridge_type, host, port, password, username=None):
    global NEXT_PORT
    local_port = NEXT_PORT
    NEXT_PORT += 1
    if NEXT_PORT > 6100:
        NEXT_PORT = 6000

    old_pid = '/tmp/%s-bridge-%s.pid' % (bridge_type, local_port)
    if os.path.exists(old_pid):
        try:
            with open(old_pid) as f:
                for pid in f.read().strip().split():
                    try: os.kill(int(pid), signal.SIGTERM)
                    except: pass
            os.remove(old_pid)
        except: pass

    if bridge_type == 'vnc':
        cmd = ['python3', '/usr/local/bin/tcp-proxy.py', str(local_port), host, str(port)]
    else:
        cmd = ['/usr/local/bin/rdp-bridge.sh', host, str(port), username or 'administrator', password or '', str(local_port)]

    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    BRIDGES[str(local_port)] = {'proc': proc, 'type': bridge_type, 'host': host}

    with open('/tmp/%s-bridge-%s.pid' % (bridge_type, local_port), 'w') as f:
        f.write(str(proc.pid))

    for i in range(30):
        time.sleep(0.5)
        try:
            s = socket.socket()
            s.settimeout(1)
            s.connect(('127.0.0.1', local_port))
            s.close()
            return local_port
        except:
            pass

    try: proc.kill()
    except: pass
    BRIDGES.pop(str(local_port), None)
    return None


class BridgeHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode()
        try:
            data = json.loads(body)
        except:
            self.send_error(400)
            return

        host = data.get('host', '')
        port = data.get('port', 5900)
        password = data.get('password', '')
        username = data.get('username', 'administrator')
        bridge_type = data.get('type', 'vnc')

        if not host:
            self.send_error(400, 'host required')
            return

        sys.stderr.write('[bridge] Starting %s bridge: %s:%s (user=%s)\n' % (bridge_type, host, port, username or ''))
        sys.stderr.flush()
        local_port = start_bridge(bridge_type, host, port, password, username)
        sys.stderr.write('[bridge] %s bridge result: port=%s\n' % (bridge_type, local_port))
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
        sys.stderr.write('[bridge] %s - - [%s] %s\n' % (self.client_address[0], self.log_date_time_string(), fmt % args))
        sys.stderr.flush()


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', 5998), BridgeHandler)
    print('Bridge API on port 5998', flush=True)
    server.serve_forever()
