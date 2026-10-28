# Source after env.sh: refuse to run a herdr command unless it targets the spike's own socket, and that socket is the default one of the spike's XDG_CONFIG_HOME
# (so the sb server is the primary one). A unix socket path longer than 103 bytes does not bind on macOS.
case "$SPIKE" in /?*) ;; *) echo "refusing: SPIKE is not an absolute path"; exit 1;; esac
case "$HERDR_SOCKET_PATH" in "$SPIKE"/*) ;; *) echo "refusing: HERDR_SOCKET_PATH is not under $SPIKE"; exit 1;; esac
case "$XDG_CONFIG_HOME" in "$SPIKE"/*) ;; *) echo "refusing: XDG_CONFIG_HOME is not under $SPIKE"; exit 1;; esac
[ "$HERDR_SOCKET_PATH" = "$XDG_CONFIG_HOME/herdr/herdr.sock" ] || { echo "refusing: HERDR_SOCKET_PATH is not the default socket of XDG_CONFIG_HOME (the server would not be primary)"; exit 1; }
[ "${#HERDR_SOCKET_PATH}" -le 100 ] || { echo "refusing: the socket path is ${#HERDR_SOCKET_PATH} bytes; use a shorter SPIKE"; exit 1; }
