source $HOME/lib/paths.zsh
add_path /opt/envhound-test/bin
path+=($HOME/bin)
export QUOTED="it's \"quoted\""
MULTI=$'line1\nline2'; export MULTI
export UNICODE='café ☕'
PREFIXED=1 true
scoped() { local LOCALVAR=1; LOCALVAR=2 }
scoped
export API_TOKEN=hunter2
TEMP=1; export TEMP; unset TEMP
SHELLONLY=yes
export GREETING=hello
GREETING+=" world"
path[1,0]=(/opt/envhound-first)
eval 'export EVALED=1'
