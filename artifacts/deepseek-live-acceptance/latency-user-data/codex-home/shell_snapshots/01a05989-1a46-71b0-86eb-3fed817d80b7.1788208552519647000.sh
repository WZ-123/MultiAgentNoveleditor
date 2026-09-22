# Snapshot file
# Unset all aliases to avoid conflicts with functions
unalias -a 2>/dev/null || true
# Functions
_ccs_profile_apply () {
	local profile="$1" 
	_ccs_profile_clear_overrides
	_ccs_profile_export_provider_env "$profile"
	case "$profile" in
		(kimi-k2.6) export ANTHROPIC_MODEL="kimi-for-coding" 
			export CLAUDE_CODE_EFFORT_LEVEL="max" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL="kimi-for-coding" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="Kimi K2.6" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="Kimi K2.6 via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,image_in,video_in" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL="kimi-for-coding" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="Kimi K2.6" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="Kimi K2.6 via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="thinking,image_in,video_in" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL="kimi-for-coding" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="Kimi K2.6" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="Kimi K2.6 via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="thinking,image_in,video_in"  ;;
		(deepseek-v4-pro) export ANTHROPIC_MODEL="deepseek-v4-pro[1m]" 
			export CLAUDE_CODE_EFFORT_LEVEL="max" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro[1m]" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="DeepSeek V4 Pro" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="DeepSeek V4 Pro via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,xhigh_effort,max_effort" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-pro[1m]" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="DeepSeek V4 Pro" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="DeepSeek V4 Pro via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,xhigh_effort,max_effort" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-pro[1m]" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="DeepSeek V4 Pro" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="DeepSeek V4 Pro via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,xhigh_effort,max_effort"  ;;
		(deepseek-v4-flash) export ANTHROPIC_MODEL="deepseek-v4-flash[1m]" 
			export CLAUDE_CODE_EFFORT_LEVEL="max" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-flash[1m]" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="DeepSeek V4 Flash" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="DeepSeek V4 Flash via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,xhigh_effort,max_effort" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash[1m]" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="DeepSeek V4 Flash" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="DeepSeek V4 Flash via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,xhigh_effort,max_effort" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash[1m]" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="DeepSeek V4 Flash" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="DeepSeek V4 Flash via Anthropic-compatible endpoint" 
			export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,xhigh_effort,max_effort"  ;;
	esac
	_ccs_profile_sync_vscode_claude_env
}
_ccs_profile_clear_overrides () {
	unset ANTHROPIC_BASE_URL
	unset ANTHROPIC_API_KEY
	unset ANTHROPIC_AUTH_TOKEN
	unset ANTHROPIC_MODEL
	unset CLAUDE_CODE_EFFORT_LEVEL
	unset CLAUDE_CODE_DISABLE_THINKING
	unset MAX_THINKING_TOKENS
	unset ANTHROPIC_DEFAULT_OPUS_MODEL
	unset ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
	unset ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION
	unset ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
	unset ANTHROPIC_DEFAULT_SONNET_MODEL
	unset ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
	unset ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION
	unset ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
	unset ANTHROPIC_DEFAULT_HAIKU_MODEL
	unset ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
	unset ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION
	unset ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
}
_ccs_profile_export_provider_env () {
	local profile="$1" 
	local provider_file="$HOME/.claude/providers.json" 
	local provider_data
	local base_url="" 
	local api_key="" 
	if [[ -f "$provider_file" ]]
	then
		provider_data="$({
      python3 - "$profile" "$provider_file" <<'PY'
import json
import sys

profile = sys.argv[1]
provider_file = sys.argv[2]

try:
    with open(provider_file, "r", encoding="utf-8") as handle:
        providers = json.load(handle)
except Exception:
    providers = {}

provider = providers.get(profile, {})
print(provider.get("base_url", ""))
print(provider.get("api_key", ""))
PY
    } 2>/dev/null)" 
		if [[ -n "$provider_data" ]]
		then
			base_url="${provider_data%%$'\n'*}" 
			api_key="${provider_data#*$'\n'}" 
			if [[ "$api_key" == "$provider_data" ]]
			then
				api_key="" 
			fi
		fi
	fi
	if [[ -n "$base_url" ]]
	then
		export ANTHROPIC_BASE_URL="$base_url" 
	fi
	if [[ -n "$api_key" ]]
	then
		export ANTHROPIC_API_KEY="$api_key" 
		export ANTHROPIC_AUTH_TOKEN="$api_key" 
	fi
}
_ccs_profile_restore () {
	local profile
	[[ -f "$CCS_ACTIVE_PROFILE_FILE" ]] || return 0
	profile="$(<"$CCS_ACTIVE_PROFILE_FILE")" 
	[[ -n "$profile" ]] || return 0
	_ccs_profile_apply "$profile"
}
_ccs_profile_set_active () {
	local profile="$1" 
	mkdir -p "$HOME/.claude"
	printf '%s\n' "$profile" > "$CCS_ACTIVE_PROFILE_FILE"
}
_ccs_profile_sync_vscode_claude_env () {
	local settings_file="$HOME/Library/Application Support/Code/User/settings.json" 
	python3 - "$settings_file" <<'PY'
import json
import os
import sys
from pathlib import Path

settings_path = Path(sys.argv[1])
env_names = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_CODE_DISABLE_THINKING",
    "MAX_THINKING_TOKENS",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
]

env_vars = []
for name in env_names:
    value = os.environ.get(name)
    if value:
        env_vars.append({"name": name, "value": value})

settings = {}
if settings_path.exists():
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except Exception:
        settings = {}

settings["claudeCode.environmentVariables"] = env_vars
settings_path.parent.mkdir(parents=True, exist_ok=True)
settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}
ccs () {
	local exit_code
	local profile="" 
	if [[ "$1" == "use" && $# -ge 2 ]]
	then
		profile="$2" 
	fi
	command ccs "$@"
	exit_code=$? 
	(( exit_code == 0 )) || return $exit_code
	if [[ -n "$profile" ]]
	then
		_ccs_profile_set_active "$profile"
		_ccs_profile_apply "$profile"
	fi
	return 0
}

# setopts 2
setopt nohashdirs
setopt login

# aliases 2
alias run-help=man
alias which-command=whence

# exports 28
export ANTHROPIC_API_KEY=sk-a62c88def6c6441b891b8d888db0adb7
export ANTHROPIC_AUTH_TOKEN=sk-a62c88def6c6441b891b8d888db0adb7
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_DEFAULT_HAIKU_MODEL='deepseek-v4-flash[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION='DeepSeek V4 Flash via Anthropic-compatible endpoint'
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME='DeepSeek V4 Flash'
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES=thinking,effort,xhigh_effort,max_effort
export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-v4-flash[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION='DeepSeek V4 Flash via Anthropic-compatible endpoint'
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME='DeepSeek V4 Flash'
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES=thinking,effort,xhigh_effort,max_effort
export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-v4-flash[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION='DeepSeek V4 Flash via Anthropic-compatible endpoint'
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME='DeepSeek V4 Flash'
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES=thinking,effort,xhigh_effort,max_effort
export ANTHROPIC_MODEL='deepseek-v4-flash[1m]'
export CLAUDE_CODE_EFFORT_LEVEL=max
export CODEX_HOME=/Users/potablewater/Desktop/MultiAgentNovelAssistant/artifacts/deepseek-live-acceptance/provider-user-data/codex-home
export HOME=/Users/potablewater
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export LOGNAME=root
export MANA_CODEX_API_KEY=sk-a62c88def6c6441b891b8d888db0adb7
export -T PATH path=( /Users/potablewater/.local/node/current/bin /Users/potablewater/.local/node/current/bin /usr/local/bin /System/Cryptexes/App/usr/bin /usr/bin /bin /usr/sbin /sbin /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin /pkg/env/global/bin /Library/Apple/usr/bin /usr/local/share/dotnet '~/.dotnet/tools' /Users/potablewater/Desktop/MultiAgentNovelAssistant/artifacts/deepseek-live-acceptance/provider-user-data/codex-home/tmp/arg0/codex-arg0hrHVHi /Users/potablewater/.local/node/current/bin /Users/potablewater/.codex/tmp/arg0/codex-arg021RMyE /Users/potablewater/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override /Users/potablewater/.lmstudio/bin /Users/potablewater/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback /Applications/ChatGPT.app/Contents/Resources /Users/potablewater/.lmstudio/bin )
export TMPDIR=/var/folders/br/44srhwzs2dg61r7fgk_g2drc0000gp/T/
export XDG_CONFIG_HOME=/Users/potablewater/Desktop/MultiAgentNovelAssistant/artifacts/deepseek-live-acceptance/provider-user-data/codex-home/xdg-config
export XDG_DATA_HOME=/Users/potablewater/Desktop/MultiAgentNovelAssistant/artifacts/deepseek-live-acceptance/provider-user-data/codex-home/xdg-data
export __CF_USER_TEXT_ENCODING=0x1F6:0x19:0x34
