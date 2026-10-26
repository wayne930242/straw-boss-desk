# Source after env.sh: refuse to run a herdr command unless it targets the spike's own socket.
case "$HERDR_SOCKET_PATH" in "$SPIKE"/run/*) ;; *) echo "refusing: HERDR_SOCKET_PATH is not under $SPIKE"; exit 1;; esac
