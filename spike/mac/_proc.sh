# Source after env.sh: process identity by pid AND start time, so a reused pid is never mistaken for ours (the kit records "pid|start" pairs).
# macOS has no /proc; `ps -o lstart=` is the start time (one-second resolution), the same text every time for one process.
proc_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }
# proc_alive PID [START]: alive, and started at START when START is given.
# An empty START is never ours: it returns 1.
proc_alive() {
  local now
  now="$(proc_start "$1")"
  [ -n "$now" ] || return 1
  [ -n "${2:-}" ] && [ "$now" = "$2" ]
}
# proc_descendants PID: pids of every descendant, one per line.
proc_descendants() {
  ps -axo pid=,ppid= | awk -v root="$1" '
    { parent[$1] = $2; ids[NR] = $1 }
    END { for (i = 1; i <= NR; i++) { p = ids[i]; q = parent[p]; d = 0; while (q != "" && q != 0 && d < 64) { if (q == root) { print p; break } q = parent[q]; d++ } } }'
}
# proc_tree PID: "pid|start" for every descendant.
# A pid whose start time cannot be read is skipped: an entry without a start time is never ours.
proc_tree() {
  local p s
  for p in $(proc_descendants "$1"); do s="$(proc_start "$p")"; [ -z "$s" ] || printf '%s|%s\n' "$p" "$s"; done
}
