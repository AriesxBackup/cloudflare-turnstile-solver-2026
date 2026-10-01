#!/bin/sh
echo "chromium procs: $(ls /proc | grep -E '^[0-9]+$' | while read p; do c=$(cat /proc/$p/comm 2>/dev/null); case "$c" in *chrom*) echo x;; esac; done | wc -l)"
echo "--- process tree (chromium, parent=1) ---"
for p in $(ls /proc | grep -E '^[0-9]+$'); do
  c=$(cat /proc/$p/comm 2>/dev/null)
  case "$c" in *chrom*)
    ppid=$(awk '{print $4}' /proc/$p/stat 2>/dev/null)
    th=$(grep Threads /proc/$p/status 2>/dev/null | awk '{print $2}')
    echo "pid=$p ppid=$ppid threads=$th cmd=$c"
  ;; esac
done
