#!/bin/bash
# VNC Bridge: TigerVNC viewer -> Xvfb -> x11vnc
# Usage: vnc-bridge.sh <vnc_host> <vnc_port> <password> <local_vnc_port>

HOST=$1
PORT=${2:-5900}
PASS=$3
LOCAL_PORT=${4:-5999}
DISPLAY_NUM=$(( 50 + RANDOM % 49 ))  # :50 - :98

echo "VNC Bridge: $HOST:$PORT -> localhost:$LOCAL_PORT (display :$DISPLAY_NUM)"

# Cleanup any leftover X lock
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null

# Start Xvfb
Xvfb :${DISPLAY_NUM} -screen 0 1280x720x24 &
XVFB_PID=$!
sleep 1

# Create VNC password file
echo "$PASS" | vncpasswd -f > /tmp/vncpass_${DISPLAY_NUM} 2>/dev/null

# Start TigerVNC viewer
export DISPLAY=:${DISPLAY_NUM}
xtigervncviewer -SecurityTypes=Tight,RA2,VncAuth,None -passwd=/tmp/vncpass_${DISPLAY_NUM} \
  -FullScreen=0 -RemoteResize=0 -ViewOnly=0 \
  ${HOST}:${PORT} &
VNCVIEWER_PID=$!
sleep 3

# Start x11vnc sharing the display
x11vnc -display :${DISPLAY_NUM} -rfbport ${LOCAL_PORT} \
  -forever -shared -nopw -noxdamage -noxrecord -nowf \
  -ncache 0 -quiet &
X11VNC_PID=$!

echo "Bridge ready: localhost:${LOCAL_PORT}"
echo "$XVFB_PID $VNCVIEWER_PID $X11VNC_PID $DISPLAY_NUM $LOCAL_PORT" > /tmp/vnc-bridge-${LOCAL_PORT}.pid

# Wait for any child to die
wait -n 2>/dev/null || true

# Cleanup
kill $XVFB_PID $VNCVIEWER_PID $X11VNC_PID 2>/dev/null
rm -f /tmp/vncpass_${DISPLAY_NUM} /tmp/vnc-bridge-${LOCAL_PORT}.pid
echo "Bridge stopped"
