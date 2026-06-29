#!/usr/bin/env python3
"""Simple TCP proxy - listens on local_port, forwards to remote_host:remote_port."""
import socket, sys, threading, os

if len(sys.argv) < 4:
    print('Usage: tcp-proxy.py <local_port> <remote_host> <remote_port>', file=sys.stderr)
    sys.exit(1)

local_port = int(sys.argv[1])
remote_host = sys.argv[2]
remote_port = int(sys.argv[3])

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(('0.0.0.0', local_port))
server.listen(10)
print('TCP proxy listening on port %s -> %s:%s' % (local_port, remote_host, remote_port), flush=True)

while True:
    try:
        client, addr = server.accept()
    except:
        break
    
    try:
        remote = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        remote.settimeout(10)
        remote.connect((remote_host, remote_port))
        remote.settimeout(None)
    except Exception as e:
        print('Proxy connect failed to %s:%s: %s' % (remote_host, remote_port, e), file=sys.stderr, flush=True)
        try: client.close()
        except: pass
        continue
    
    print('Proxy connected: %s:%s -> %s:%s' % (addr[0], addr[1], remote_host, remote_port), flush=True)
    
    def forward(src, dst, tag):
        try:
            while True:
                data = src.recv(16384)
                if not data:
                    break
                dst.sendall(data)
        except:
            pass
        finally:
            try: dst.close()
            except: pass
    
    threading.Thread(target=forward, args=(client, remote, 'c2r'), daemon=True).start()
    threading.Thread(target=forward, args=(remote, client, 'r2c'), daemon=True).start()
