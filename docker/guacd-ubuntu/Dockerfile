FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config \
    freerdp2-dev libwinpr2-dev \
    libssh2-1-dev libssl-dev libcairo2-dev libjpeg-turbo8-dev \
    libpng-dev libwebp-dev libpango1.0-dev libpulse-dev \
    libavcodec-dev libavutil-dev libswscale-dev \
    libvncserver-dev libgcrypt20-dev \
    wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN wget -q https://dlcdn.apache.org/guacamole/1.5.5/source/guacamole-server-1.5.5.tar.gz && \
    tar xzf guacamole-server-1.5.5.tar.gz && \
    cd guacamole-server-1.5.5 && \
    ./configure --with-init-dir=/etc/init.d --disable-guaclog && \
    make -j$(nproc) && make install && ldconfig

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    libfreerdp2-2t64 libfreerdp-client2-2t64 libwinpr2-2t64 \
    libssh2-1t64 libcairo2 libjpeg-turbo8 \
    libpng16-16t64 libwebp7 libpango-1.0-0 libpulse0 \
    libvncserver1 libgcrypt20 netcat-openbsd \
    openssl ca-certificates freerdp2-x11 xvfb x11vnc \
    tigervnc-viewer tigervnc-standalone-server \
    gcc libc6-dev libssl-dev python3 binutils && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/sbin/guacd /usr/local/sbin/guacd
COPY --from=builder /usr/local/lib/ /usr/local/lib/

COPY sslbypass.c /tmp/sslbypass.c

RUN cd /usr/local/lib && \
    for f in libguac-client-rdp libguac-client-ssh libguac-client-vnc libguac-terminal; do \
      if [ -f "${f}.so.0.0.0" ]; then \
        rm -f "${f}.so" "${f}.so.0" && \
        ln -sf "${f}.so.0.0.0" "${f}.so.0" && ln -sf "${f}.so.0" "${f}.so"; \
      fi; \
    done && \
    rm -f libguac.so libguac.so.24 && \
    ln -sf libguac.so.24.0.0 libguac.so.24 && ln -sf libguac.so.24 libguac.so && \
    ldconfig && \
    gcc -shared -fPIC -o /usr/local/lib/sslbypass.so /tmp/sslbypass.c -ldl -lssl -lcrypto && \
    rm /tmp/sslbypass.c

COPY rdp-bridge.sh /usr/local/bin/rdp-bridge.sh
COPY vnc-bridge.sh /usr/local/bin/vnc-bridge.sh
COPY bridge-api.py /usr/local/bin/bridge-api.py
COPY patch-rdp.sh /usr/local/bin/patch-rdp.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/rdp-bridge.sh /usr/local/bin/vnc-bridge.sh \
    /usr/local/bin/bridge-api.py /usr/local/bin/patch-rdp.sh /entrypoint.sh

EXPOSE 4822
ENTRYPOINT ["/entrypoint.sh"]
