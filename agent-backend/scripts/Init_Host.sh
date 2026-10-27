#!/bin/bash
Red='\033[0;31m'
Blue='\033[0;34m'
Green='\033[0;32m'
Yellow='\033[1;33m'
NC='\033[0m' # No Color
BLACK="\e[30m"
MAGENTA="\e[35m"
CYAN="\e[36m"
WHITE="\e[97m"
BOLD="\e[1m"
DIM="\e[2m"

ARROW="❯"
CHECK="✔"
CROSS="✖"
WARNING="⚠"
INFO="ℹ"

# virtnbdbackup is installed from the upstream release .deb
# (https://github.com/abbbi/virtnbdbackup/releases). apt resolves its
# dependencies (python3-libnbd, python3-libvirt, nbdkit, qemu-utils, ...)
# from the distribution repositories. A copy of the .deb ships next to this
# script for hosts that cannot reach GitHub; VIRTNBD_DEB=/path/to/file.deb
# overrides it.
VIRTNBD_VERSION="2.53"
VIRTNBD_DEB_NAME="virtnbdbackup_${VIRTNBD_VERSION}-1_all.deb"
VIRTNBD_DEB_SHA256="33bfcf8a832605f716c87e6eb8502820cd7467873917a32fcedb47dafc60f2d7"
VIRTNBD_DEB_URL="https://github.com/abbbi/virtnbdbackup/releases/download/v${VIRTNBD_VERSION}/${VIRTNBD_DEB_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DEBIAN_FRONTEND=noninteractive

fail() {
	echo -e "${Red}${CROSS} $*${NC}" >&2
	exit 1
}

apt_update_repo_check() {
	if [[ $already_checked != "true" ]]; then
		echo -e "${Green}Updating Repository ...${NC}"
		if ! apt-get update &>/dev/null; then
			fail "Error in Repo, cannot apt update."
		fi
		already_checked="true"
	fi
}

check_os() {
	[[ $EUID -eq 0 ]] || fail "This script must be run as root."
	[[ -f /etc/os-release ]] || fail "Cannot detect the OS (/etc/os-release missing)."
	source /etc/os-release
	os_major=${VERSION_ID%%.*}
	case "$ID" in
	debian)
		# libvirt/qemu in Debian 10 lack incremental backup support
		[[ $os_major -ge 11 ]] || fail "Debian ${VERSION_ID} is not supported (Debian 11+ required)."
		[[ $os_major -eq 11 ]] && echo -e "${Yellow}${WARNING} Debian 11: VMs need the 'incremental-backup' qemu capability enabled (see virtnbdbackup README).${NC}"
		;;
	ubuntu)
		[[ $os_major -ge 22 ]] || fail "Ubuntu ${VERSION_ID} is not supported (Ubuntu 22.04+ required)."
		;;
	*)
		fail "Unsupported distribution '${ID}'. Only Debian and Ubuntu are supported."
		;;
	esac
}

# Prints the installed virtnbdbackup version, or nothing if not installed
installed_virtnbd_version() {
	command -v virtnbdbackup >/dev/null 2>&1 || return 0
	virtnbdbackup -V 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -n1
}

# Older versions of this script installed virtnbdbackup with pip/setup.py into
# /usr/local, which would shadow the packaged binaries in /usr/bin.
remove_legacy_virtnbd_install() {
	local bin
	bin=$(command -v virtnbdbackup 2>/dev/null || true)
	[[ $bin == /usr/local/* ]] || return 0
	echo -e "${Yellow}${WARNING} Removing legacy pip installation of virtnbdbackup (${bin})${NC}"
	pip3 uninstall -y --break-system-packages virtnbdbackup &>/dev/null ||
		pip3 uninstall -y virtnbdbackup &>/dev/null || true
	rm -f /usr/local/bin/virtnbdbackup /usr/local/bin/virtnbdrestore \
		/usr/local/bin/virtnbdmap /usr/local/bin/virtnbd-nbdkit-plugin
	hash -r
}

# Prints the path of a verified .deb (bundled, VIRTNBD_DEB, or downloaded)
fetch_virtnbd_deb() {
	local deb="${VIRTNBD_DEB:-${SCRIPT_DIR}/../virtnbdbackup/${VIRTNBD_DEB_NAME}}"
	if [[ ! -f $deb ]]; then
		deb="$(mktemp -d)/${VIRTNBD_DEB_NAME}"
		echo -e "${Green}Downloading ${VIRTNBD_DEB_URL} ...${NC}" >&2
		curl -fsSL --retry 3 --connect-timeout 20 -o "$deb" "$VIRTNBD_DEB_URL" ||
			fail "Download failed. Copy ${VIRTNBD_DEB_NAME} to $(realpath -m "${SCRIPT_DIR}/../virtnbdbackup")/ or set VIRTNBD_DEB=/path/to/file.deb"
	fi
	# Only verify the pinned checksum for the pinned release file
	if [[ $(basename "$deb") == "$VIRTNBD_DEB_NAME" ]]; then
		echo "${VIRTNBD_DEB_SHA256}  ${deb}" | sha256sum -c --status ||
			fail "Checksum mismatch for ${deb}"
	fi
	echo "$deb"
}

configure_apparmor() {
	command -v apparmor_parser >/dev/null 2>&1 || return 0
	local rules=("/var/tmp/virtnbdbackup.* rw," "/var/tmp/backup.* rw,")
	local files=(
		/etc/apparmor.d/abstractions/libvirt-qemu.d/virtnbdbackup
		/etc/apparmor.d/local/abstractions/libvirt-qemu
	)
	local f rule
	for f in "${files[@]}"; do
		mkdir -p "$(dirname "$f")"
		touch "$f"
		for rule in "${rules[@]}"; do
			grep -qxF "$rule" "$f" || echo "$rule" >>"$f"
		done
	done
	if systemctl is-active --quiet apparmor; then
		systemctl reload apparmor || echo -e "${Yellow}${WARNING} apparmor reload failed${NC}"
	fi
	echo -e "${Green}AppArmor rules for virtnbdbackup [OK]${CHECK}${NC}"
}

function install_virtnbdbackup {
	local current deb
	remove_legacy_virtnbd_install
	current=$(installed_virtnbd_version)

	if [[ -n $current ]] && dpkg --compare-versions "$current" ge "$VIRTNBD_VERSION"; then
		echo -e "${Green}virtnbdbackup ${current} already installed${CHECK}${NC}"
	else
		echo "virtnbdbackup package status : ${current:-Not Installed} (target ${VIRTNBD_VERSION})"
		deb=$(fetch_virtnbd_deb) || exit 1
		echo -e "\nInstalling virtnbdbackup ${VIRTNBD_VERSION} and its dependencies, Please Wait ...⏳"
		# apt installs a local .deb only when given a path containing a slash
		if ! apt-get install -y "$(realpath "$deb")"; then
			fail "Failed to install virtnbdbackup from ${deb}"
		fi
		current=$(installed_virtnbd_version)
		[[ -n $current ]] || fail "virtnbdbackup installed but 'virtnbdbackup -V' does not run"
		echo -e "\n${Green}${CHECK}virtnbdbackup ${current} installed successfully ${NC}"
	fi

	# Working directory used by the backup scripts
	mkdir -p /tmp/vm_inc/
	configure_apparmor

	echo "package_name                    status"
	echo "------------------------------------------"
	echo "virtnbdbackup                  Installed (${current})"
}
function main() {
	check_os
	apt_update_repo_check
	# Tools used by the backup/restore/offsite scripts (virtnbdbackup's own
	# dependencies are pulled in by its .deb)
	packages=(curl ca-certificates bc jq libvirt-clients nfs-common rsync tmux python3-paramiko)
	echo -e "${Green}Installing ${packages[*]}${NC}"
	echo -e "Please Wait... ⏳ (This can take a while)"
	if ! apt-get install -y "${packages[@]}" &>/dev/null; then
		echo "There's a problem installing: ${packages[*]}" >&2
		exit 2
	fi
	echo -e "${Green}Base packages [Installed/Updated]${CHECK}${NC}"

	install_virtnbdbackup

	# =========================
	# Server config (sshd)
	# =========================
	SSHD_FILE="/etc/ssh/sshd_config"

	set_sshd() {
		local key="$1"
		local value="$2"

		if grep -qE "^[#]*\s*${key}\b" "$SSHD_FILE"; then
			sed -i "s|^[#]*\s*${key}\b.*|$key $value|" "$SSHD_FILE"
			echo "♻ sshd: updated $key"
		else
			echo "$key $value" >>"$SSHD_FILE"
			echo "➕ sshd: added $key"
		fi
	}

	# =========================
	# Client config (ssh)
	# =========================
	SSH_FILE="/etc/ssh/ssh_config"

	ensure_client_setting() {
		local key="$1"
		local value="$2"

		if grep -qE "^[[:space:]]*$key\b" "$SSH_FILE"; then
			sed -i "s|^[[:space:]]*$key\b.*|    $key $value|" "$SSH_FILE"
			echo "♻ ssh: updated $key"
		else
			awk -v k="$key" -v v="$value" '
        BEGIN {done=0}
        /^Host \*/ {
            print
            print "    " k " " v
            done=1
            next
        }
        {print}
        END { if (!done) { print "Host *"; print "    " k " " v } }
        ' "$SSH_FILE" >/tmp/ssh_config.tmp && cat /tmp/ssh_config.tmp >"$SSH_FILE" && rm -f /tmp/ssh_config.tmp

			echo "➕ ssh: added $key"
		fi
	}

	ensure_client_setting "ServerAliveInterval" "30"
	ensure_client_setting "ServerAliveCountMax" "10"
	ensure_client_setting "TCPKeepAlive" "yes"

	# =========================
	# validate + restart safely
	# =========================
	if ! sshd -t; then
		echo "❌ sshd configuration test failed, not restarting ssh" >&2
		exit 1
	fi

	if systemctl list-unit-files | grep -q "^ssh\.service"; then
		systemctl restart ssh
	elif systemctl list-unit-files | grep -q "^sshd\.service"; then
		systemctl restart sshd
	else
		echo "❌ No SSH service found"
		exit 1
	fi

	echo "✅ SSH tuning applied successfully"

}

main
