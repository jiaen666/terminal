FROM node:22-alpine
WORKDIR /app

# RDP/VNC bridge deps: Xvfb + x11vnc + rdesktop + socat + openssl + python3 for TLS proxy
RUN apk add --no-cache xvfb x11vnc rdesktop bash socat openssl python3

COPY package.json ./
RUN npm install --production

COPY rdp-tls-proxy.py ./
COPY server.js ./
COPY public/ ./public/

EXPOSE 3000
CMD ["node", "server.js"]
