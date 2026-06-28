#!/usr/bin/env python3
"""
RDP TLS MITM Proxy
Terminates server TLS (accepts any cert), creates fresh TLS for client.
"""
import socket, ssl, threading, sys, os, subprocess, time, struct, signal

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 13389
RDP_HOST = sys.argv[2] if len(sys.argv) > 2 else "172.30.64.6"
RDP_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 3389

def handle_client(client_sock):
    """Handle one client connection - full RDP proxy with TLS MITM"""
    server_sock = None
    tls_server = None
    try:
        # Phase 1: Connect to server and forward Nego transparently
        server_sock = socket.create_connection((RDP_HOST, RDP_PORT), timeout=15)
        
        # Forward Nego: client -> server
        nego_req = client_sock.recv(1024)
        if not nego_req:
            return
        server_sock.sendall(nego_req)
        
        # Get Nego response
        nego_resp = server_sock.recv(1024)
        if not nego_resp:
            client_sock.sendall(nego_req)  # echo back
            return
        
        # Forward Nego response to client
        client_sock.sendall(nego_resp)
        
        # Phase 2: TLS interception
        # Client will now start TLS to us. We create a local TLS server.
        # Server TLS: we connect with cert validation disabled.
        
        # Create TLS connection to server (accept any cert)
        ctx_server = ssl.create_default_context()
        ctx_server.check_hostname = False
        ctx_server.verify_mode = ssl.CERT_NONE
        ctx_server.minimum_version = ssl.TLSVersion.TLSv1_2
        tls_server = ctx_server.wrap_socket(server_sock, server_hostname=RDP_HOST)
        
        # Create TLS server for client (with a self-signed cert)
        ctx_client = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx_client.check_hostname = False
        ctx_client.verify_mode = ssl.CERT_NONE
        ctx_client.minimum_version = ssl.TLSVersion.TLSv1_2
        # Use the same cert the server presented
        ctx_client.load_cert_chain(certfile="/tmp/proxy-cert.pem", keyfile="/tmp/proxy-key.pem")
        
        tls_client = ctx_client.wrap_socket(client_sock, server_side=True)
        
        print(f"[Proxy] TLS established, forwarding RDP traffic", file=sys.stderr)
        
        # Phase 3: Bidirectional forwarding
        def forward(src, dst, direction):
            try:
                while True:
                    data = src.recv(8192)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try: dst.close()
                except: pass
        
        t1 = threading.Thread(target=forward, args=(tls_client, tls_server, "C->S"))
        t2 = threading.Thread(target=forward, args=(tls_server, tls_client, "S->C"))
        t1.daemon = True; t2.daemon = True
        t1.start(); t2.start()
        t1.join(timeout=300); t2.join(timeout=300)
        
    except Exception as e:
        print(f"[Proxy] Error: {e}", file=sys.stderr)
    finally:
        try: client_sock.close()
        except: pass
        if server_sock:
            try: server_sock.close()
            except: pass

def main():
    print(f"[Proxy] Listening on :{LISTEN_PORT} -> {RDP_HOST}:{RDP_PORT}", file=sys.stderr)
    
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", LISTEN_PORT))
    server.listen(10)
    
    while True:
        client, addr = server.accept()
        threading.Thread(target=handle_client, args=(client,), daemon=True).start()

if __name__ == "__main__":
    # Generate self-signed cert for client-side
    os.system("openssl req -x509 -newkey rsa:2048 -keyout /tmp/proxy-key.pem -out /tmp/proxy-cert.pem -days 3650 -nodes -subj '/CN=RDP-Proxy' 2>/dev/null")
    main()
