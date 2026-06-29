#!/bin/bash
# VNC Bridge: TigerVNC viewer -> Xvfb -> x11vnc
# Usage: vnc-bridge.sh <vnc_host> <vnc_port> <password> <local_vnc_port>

HOST=$1
PORT=${2:-5900}
PASS=$3
LOCAL_PORT=${4:-5999}
DISPLAY_NUM=$(( 50 + RANDOM % 49 ))

echo "VNC Bridge: $HOST:$PORT -> localhost:$LOCAL_PORT (display :$DISPLAY_NUM)" >&2

# Cleanup
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null

# Start Xvfb
Xvfb :${DISPLAY_NUM} -screen 0 1280x720x24 -ac +extension RANDR &
XVFB_PID=$!
sleep 2

# Verify Xvfb started
if ! kill -0 $XVFB_PID 2>/dev/null; then
  echo "Xvfb failed to start" >&2
  exit 1
fi

# Find TigerVNC viewer binary
VNCVIEWER=""
for bin in xtigervncviewer vncviewer xtightvncviewer; do
  if command -v $bin >/dev/null 2>&1; then
    VNCVIEWER=$bin
    break
  fi
done

if [ -z "$VNCVIEWER" ]; then
  echo "No VNC viewer found" >&2
  kill $XVFB_PID 2>/dev/null
  exit 1
fi

export DISPLAY=:${DISPLAY_NUM}

# Create VNC password file
if [ -n "$PASS" ]; then
  echo "$PASS" | vncpasswd -f > /tmp/vncpass_${DISPLAY_NUM} 2>/dev/null
  $VNCVIEWER -SecurityTypes=Tight,RA2,VncAuth,None -passwd=/tmp/vncpass_${DISPLAY_NUM} \
    -FullScreen=0 -RemoteResize=0 -ViewOnly=0 \
    ${HOST}:${PORT} >/dev/null 2>&1 &
else
  $VNCVIEWER -SecurityTypes=None,Tight,RA2,VncAuth -FullScreen=0 -RemoteResize=0 -ViewOnly=0 \
    ${HOST}:${PORT} >/dev/null 2>&1 &
fi
VNCVIEWER_PID=$!
sleep 3

# Verify VNC viewer connected
if ! kill -0 $VNCVIEWER_PID 2>/dev/null; then
  echo "VNC viewer failed to start or disconnected" >&2
  kill $XVFB_PID 2>/dev/null
  exit 1
fi

# Start x11vnc
x11vnc -display :${DISPLAY_NUM} -rfbport ${LOCAL_PORT} \
  -forever -shared -nopw -noxdamage -noxrecord -nowf \
  -ncache 0 -quiet &
X11VNC_PID=$!
sleep 2

if ! kill -0 $X11VNC_PID 2>/dev/null; then
  echo "x11vnc failed to start" >&2
  kill $XVFB_PID $VNCVIEWER_PID 2>/dev/null
  exit 1
fi

echo "Bridge ready: localhost:$LOCAL_PORT" >&2
echo "$XVFB_PID $VNCVIEWER_PID $X11VNC_PID $DISPLAY_NUM $LOCAL_PORT" > /tmp/vnc-bridge-${LOCAL_PORT}.pid

# Wait for any child to die
wait -n 2>/dev/null || true

# Cleanup
kill $XVFB_PID $VNCVIEWER_PID $X11VNC_PID 2>/dev/null
rm -f /tmp/vncpass_${DISPLAY_NUM} /tmp/vnc-bridge-${LOCAL_PORT}.pid
echo "Bridge stopped" >&2
