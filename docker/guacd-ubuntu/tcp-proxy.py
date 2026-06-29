#!/usr/bin/env python3
"""Simple TCP proxy with verbose logging."""
import socket, sys, threading, os, time

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
print('[tcp-proxy:%s] Listening -> %s:%s' % (local_port, remote_host, remote_port), flush=True)

conn_id = 0

while True:
    try:
        client, addr = server.accept()
    except Exception as e:
        print('[tcp-proxy:%s] Accept error: %s' % (local_port, e), file=sys.stderr, flush=True)
        break
    
    conn_id += 1
    cid = conn_id
    print('[tcp-proxy:%s] #%d Client connected from %s:%s' % (local_port, cid, addr[0], addr[1]), flush=True)
    
    try:
        remote = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        remote.settimeout(10)
        remote.connect((remote_host, remote_port))
        remote.settimeout(None)
        print('[tcp-proxy:%s] #%d Remote %s:%s connected' % (local_port, cid, remote_host, remote_port), flush=True)
    except Exception as e:
        print('[tcp-proxy:%s] #%d Remote connect FAILED: %s' % (local_port, cid, e), file=sys.stderr, flush=True)
        try: client.close()
        except: pass
        continue
    
    total_c2r = [0]
    total_r2c = [0]
    done = [False, False]
    
    def forward(src, dst, tag, count, idx):
        try:
            while True:
                data = src.recv(16384)
                if not data:
                    break
                dst.sendall(data)
                count[0] += len(data)
        except Exception as e:
            if not done[idx]:
                print('[tcp-proxy:%s] #%d %s error: %s' % (local_port, cid, tag, e), file=sys.stderr, flush=True)
        finally:
            done[idx] = True
            try: dst.close()
            except: pass
            if done[0] and done[1]:
                print('[tcp-proxy:%s] #%d Closed (c2r=%d r2c=%d)' % (local_port, cid, total_c2r[0], total_r2c[0]), flush=True)
    
    threading.Thread(target=forward, args=(client, remote, 'c2r', total_c2r, 0), daemon=True).start()
    threading.Thread(target=forward, args=(remote, client, 'r2c', total_r2c, 1), daemon=True).start()
