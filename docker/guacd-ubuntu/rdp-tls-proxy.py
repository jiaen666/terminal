#!/usr/bin/env python3
"""
RDP TLS Proxy - connects to RDP server with cert verification disabled,
presents server's actual cert to the client (guacd).
"""
import socket, ssl, threading, sys, os, time

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 13389
RDP_HOST = sys.argv[2] if len(sys.argv) > 2 else "172.30.64.6"
RDP_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 3389

def handle_client(client_sock):
    server_sock = None
    try:
        # Phase 1: Connect to RDP server and do Nego exchange
        server_sock = socket.create_connection((RDP_HOST, RDP_PORT), timeout=15)
        
        # Forward Nego request from client to server
        nego_req = client_sock.recv(4096)
        if not nego_req: return
        server_sock.sendall(nego_req)
        
        # Get Nego response from server
        nego_resp = server_sock.recv(4096)
        if not nego_resp: return
        
        # Forward Nego response to client
        client_sock.sendall(nego_resp)
        
        # Phase 2: TLS
        # Connect to RDP server with NO cert verification
        ssl_ctx_server = ssl.create_default_context()
        ssl_ctx_server.check_hostname = False
        ssl_ctx_server.verify_mode = ssl.CERT_NONE
        ssl_ctx_server.minimum_version = ssl.TLSVersion.TLSv1_2
        
        tls_server = ssl_ctx_server.wrap_socket(server_sock, server_hostname=RDP_HOST)
        
        # Get the server's certificate
        server_cert = tls_server.getpeercert(binary_form=True)
        
        # Write server cert to temp file for client-side TLS
        cert_pem = ssl.DER_cert_to_PEM_cert(server_cert)
        with open('/tmp/rdp-server-cert.pem', 'wb') as f:
            f.write(cert_pem)
        
        # Create TLS server for client using server's certificate
        ssl_ctx_client = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx_client.check_hostname = False
        ssl_ctx_client.verify_mode = ssl.CERT_NONE
        ssl_ctx_client.minimum_version = ssl.TLSVersion.TLSv1_2
        ssl_ctx_client.load_cert_chain(certfile='/tmp/rdp-server-cert.pem')
        
        tls_client = ssl_ctx_client.wrap_socket(client_sock, server_side=True)
        
        # Phase 3: Bidirectional forwarding
        def forward(src, dst, name):
            try:
                while True:
                    data = src.recv(8192)
                    if not data: break
                    dst.sendall(data)
            except: pass
            finally:
                try: dst.close()
                except: pass
        
        t1 = threading.Thread(target=forward, args=(tls_client, tls_server, "C->S"), daemon=True)
        t2 = threading.Thread(target=forward, args=(tls_server, tls_client, "S->C"), daemon=True)
        t1.start(); t2.start()
        t1.join(timeout=300); t2.join(timeout=300)
        
    except Exception as e:
        print(f"[RDP Proxy] Error: {e}", file=sys.stderr)
    finally:
        try: client_sock.close()
        except: pass
        if server_sock:
            try: server_sock.close()
            except: pass

def main():
    print(f"[RDP Proxy] Listening on 0.0.0.0:{LISTEN_PORT} -> {RDP_HOST}:{RDP_PORT}", file=sys.stderr)
    
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', LISTEN_PORT))
    server.listen(10)
    
    while True:
        client, addr = server.accept()
        print(f"[RDP Proxy] Connection from {addr}", file=sys.stderr)
        threading.Thread(target=handle_client, args=(client,), daemon=True).start()

if __name__ == '__main__':
    main()
