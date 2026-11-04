#!/bin/bash
set -u
MAIN=$1; OUT=$2
printf 'utc\tsample\tpid\tppid\tname\trss_kib\tvmhwm_kib\tanon_kib\tpss_kib\tprivate_kib\n' > "$OUT"
SAMPLE=0
collect_tree() { local pid=$1 child; [ -r "/proc/$pid/status" ] || return 0; printf '%s\n' "$pid"; for child in $(ps -o pid= --ppid "$pid" 2>/dev/null); do collect_tree "$child"; done; }
while kill -0 "$MAIN" 2>/dev/null; do
 SAMPLE=$((SAMPLE+1)); UTC=$(date -u +%FT%T.%3NZ)
 for PID in $(collect_tree "$MAIN"); do
  [ -r "/proc/$PID/status" ] || continue
  awk -v utc="$UTC" -v sample="$SAMPLE" -v pid="$PID" '
   /^Name:/ {name=$2} /^PPid:/ {ppid=$2} /^VmRSS:/ {rss=$2} /^VmHWM:/ {hwm=$2} /^RssAnon:/ {anon=$2} /^Pss:/ {pss=$2} /^Private_(Clean|Dirty):/ {private+=$2}
   END {printf "%s\t%d\t%d\t%d\t%s\t%d\t%d\t%d\t%d\t%d\n",utc,sample,pid,ppid,name,rss,hwm,anon,pss,private}
  ' "/proc/$PID/status" "/proc/$PID/smaps_rollup" 2>/dev/null >> "$OUT"
 done
 sleep 1
done
