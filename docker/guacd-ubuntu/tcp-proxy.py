#!/usr/bin/env python3
"""TCP proxy with first-packet hex dump for debugging."""
import socket, sys, threading

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

cid = 0

while True:
    try:
        client, addr = server.accept()
    except:
        break
    cid += 1; c = cid
    print('[tcp-proxy:%s] #%d ACCEPT %s:%s' % (local_port, c, addr[0], addr[1]), flush=True)
    try:
        remote = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        remote.settimeout(10)
        remote.connect((remote_host, remote_port))
        remote.settimeout(None)
    except Exception as e:
        print('[tcp-proxy:%s] #%d REMOTE FAIL: %s' % (local_port, c, e), file=sys.stderr, flush=True)
        try: client.close()
        except: pass
        continue

    first_r2c = [True]
    first_c2r = [True]

    def forward(src, dst, tag, first_flag, other_first):
        try:
            while True:
                data = src.recv(16384)
                if not data: break
                if first_flag[0]:
                    first_flag[0] = False
                    hexdump = ' '.join('%02x' % b for b in data[:80])
                    ascii_repr = ''.join(chr(b) if 32 <= b < 127 else '.' for b in data[:80])
                    print('[tcp-proxy:%s] #%d %s FIRST %d bytes: %s |%s|' % (local_port, c, tag, len(data), hexdump, ascii_repr), flush=True)
                dst.sendall(data)
        except Exception as e:
            print('[tcp-proxy:%s] #%d %s ERR: %s' % (local_port, c, tag, e), file=sys.stderr, flush=True)
        finally:
            try: dst.close()
            except: pass

    threading.Thread(target=forward, args=(client, remote, 'C->S', first_c2r, first_r2c), daemon=True).start()
    threading.Thread(target=forward, args=(remote, client, 'S->C', first_r2c, first_c2r), daemon=True).start()
