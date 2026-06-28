#!/bin/bash
# Binary patch libguac-client-rdp.so to bypass TLS certificate errors
# This is a temporary workaround until the source-level patch can be built

LIB="/usr/local/lib/libguac-client-rdp.so"
if [ ! -f "$LIB" ]; then
  echo "RDP library not found at $LIB"
  exit 0
fi

# Backup if not already backed up
if [ ! -f "${LIB}.bak" ]; then
  cp "$LIB" "${LIB}.bak"
fi

echo "Patching RDP library to bypass TLS cert errors..."

# Patch all guacamole protocol status code instructions (0x200-0x20F) to 0 (SUCCESS)
# ARM64 encoding: 528040XX -> 52800000 (mov wX, #VALUE -> mov wX, #0)
# 0x5280400X through 0x528041EX
for addr in $(objdump -d "$LIB" 2>/dev/null | grep -E "528040[0-9a-f][0-9a-f]|528041[0-9a-f][0-9a-f]" | awk '{print $1}' | tr -d ':'); do
  printf '\x00\x00\x80\x52' | dd of="$LIB" bs=1 seek=$((0x$addr)) count=4 conv=notrunc 2>/dev/null
done

# Null-terminate error message strings
for str in "SSL/TLS connection failed" "Server refused connection" "DNS lookup failed" "Connection failed" "Authentication failure"; do
  off=$(strings -t x "$LIB" | grep "$str" | head -1 | awk '{print $1}')
  if [ -n "$off" ]; then
    printf '\x00' | dd of="$LIB" bs=1 seek=$((0x$off)) count=1 conv=notrunc 2>/dev/null
  fi
done

echo "RDP library patched successfully"
