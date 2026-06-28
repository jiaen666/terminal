#!/bin/bash
# RDP Bridge: xfreerdp3 -> Xvfb -> x11vnc -> guacd VNC
HOST=$1; PORT=${2:-3389}; USER=${3:-administrator}; PASS=$4; LOCAL_PORT=${5:-5999}
DISPLAY_NUM=$((70 + RANDOM % 29))

echo "RDP Bridge: $HOST:$PORT -> localhost:$LOCAL_PORT"

rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null

Xvfb :${DISPLAY_NUM} -screen 0 1280x720x24 &
XVFB_PID=$!
sleep 1

export DISPLAY=:${DISPLAY_NUM}

xfreerdp3 /v:${HOST} /u:${USER} /p:"${PASS}" /cert:ignore /w:1280 /h:720 +fonts +glyph-cache 2>/dev/null &
XFREERDP_PID=$!
sleep 5

x11vnc -display :${DISPLAY_NUM} -rfbport ${LOCAL_PORT} -forever -shared -nopw -quiet &
X11VNC_PID=$!

echo "RDP Bridge ready: localhost:$LOCAL_PORT"
echo "$XVFB_PID $XFREERDP_PID $X11VNC_PID $DISPLAY_NUM $LOCAL_PORT" > /tmp/rdp-bridge-${LOCAL_PORT}.pid

wait -n 2>/dev/null || true
kill $XVFB_PID $XFREERDP_PID $X11VNC_PID 2>/dev/null
rm -f /tmp/rdp-bridge-${LOCAL_PORT}.pid
