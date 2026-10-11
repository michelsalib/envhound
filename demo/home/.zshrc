source ~/.config/zsh/functions.zsh
export PYENV_ROOT=$HOME/.pyenv
path=($PYENV_ROOT/shims $path)
add_path $HOME/.cargo/bin
export EDITOR=nvim
