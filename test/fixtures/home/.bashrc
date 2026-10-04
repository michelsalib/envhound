add_path() { case ":$PATH:" in *":$1:"*) ;; *) PATH="$PATH:$1" ;; esac; }
add_path /opt/envhound-test/bin
PATH+=":$HOME/bin"
export QUOTED="it's \"quoted\""
MULTI=$'line1\nline2'; export MULTI
export UNICODE='café ☕'
SHELL=/bin/sh true
scoped() { local LOCALVAR=1; LOCALVAR=2; }
scoped
export API_TOKEN=hunter2
TEMP=1; export TEMP; unset TEMP
SHELLONLY=yes
export GREETING=hello
GREETING+=" world"
