#!/bin/sh
echo "=== main browser (ppid != chromium) cmdline ==="
for p in 80 250 251 253 749 765; do
  echo "--- pid $p ---"
  tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | head -c 900
  echo
done
echo
echo "=== renderer child flags (one sample) ==="
for p in 135 167 174; do
  echo "--- pid $p (parent $(awk '{print $4}' /proc/$p/stat)) ---"
  tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -o -- '--type=[a-z-]*' | sort | uniq -c
done
