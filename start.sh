#!/bin/sh
set -e

# Start guacd daemon in background
echo "Starting guacd..."
/opt/guacamole/sbin/guacd -b 0.0.0.0 -l 4822 -f &
GUACD_PID=$!

# Wait for guacd to be ready
sleep 1
echo "guacd started (PID: $GUACD_PID)"

# Start Node.js server
echo "Starting Super Terminal..."
exec node server.js
