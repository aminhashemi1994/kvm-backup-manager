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

apt_update_repo_check() {
	if [[ $already_checked != "true" ]]; then
		echo -e "${Green}Updating Reposiroty ...${NC}"
		if ! apt update &>/dev/null; then
			echo -e "${Red}${CROSS}Error in Repo, cannot apt update.${NC}"
			exit 1
		fi
		already_checked="true"
	fi
}

function install_virtnbdbackup {
	current_dir=$(pwd)
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	VIRTNBD_DIR="${SCRIPT_DIR}/../virtnbdbackup/virtnbdbackup"

	virtnbdbackup -V >/dev/null 2>&1
	if [[ $? -ne 0 ]]; then
		source /etc/os-release
		echo "virtnbdbackup package status : Not Installed"

		# Check if virtnbdbackup directory exists
		if [[ ! -d "${VIRTNBD_DIR}" ]]; then
			echo -e "${Red}${CROSS}virtnbdbackup directory not found at ${VIRTNBD_DIR}${NC}"
			echo -e "${Yellow}Please ensure virtnbdbackup directory is located in agent-backend/virtnbdbackup/.${NC}"
			exit 1
		fi

		# Check Debian version compatibility
		[[ $VERSION_ID -eq "10" ]] && echo "Debian Version is 10 (Buster) Does not support Virtnbd Backup Feature" && exit 1

		# Create necessary directories
		[[ ! -d /tmp/vm_inc/ ]] && mkdir -p /tmp/vm_inc/

		echo -e "\n${Green}${CHECK}virtnbdbackup directory found at ${VIRTNBD_DIR}${NC}"
		echo -e "\nPlease Wait ...⏳"

		# Determine pip packages based on Debian version
		if [[ $VERSION_ID -eq "12" ]]; then
			pip_list=$(cat ${VIRTNBD_DIR}/pip_files/deb12_packages.txt)
		else
			pip_list=$(cat ${VIRTNBD_DIR}/pip_files/package_list.txt)
		fi

		# Install pip packages
		for list in ${pip_list[@]}; do
			echo -e "${Green}Installing $list, Please Wait ...⏳"
			pip3 install $force_install --no-index ${VIRTNBD_DIR}/pip_files/$list
			echo -e "${Green}$list [OK]${CHECK}${NC}"
		done

		# Install virtnbdbackup
		cd ${VIRTNBD_DIR}/
		if ! python3 setup.py install &>/dev/null; then
			echo -e "${Red}${CROSS}Failed to install virtnbdbackup ${NC}"
			cd $current_dir
			exit 1
		fi

		# Configure AppArmor permissions
		[[ ! -f /etc/apparmor.d/local/abstractions/libvirt-qemu ]] && mkdir -p /etc/apparmor.d/local/abstractions/
		[[ ! -f /etc/apparmor.d/local/usr.sbin.libvirtd ]] && mkdir -p /etc/apparmor.d/local/
		[[ ! -f /etc/apparmor.d/local/usr.lib.libvirt.virt-aa-helper ]] && mkdir -p /etc/apparmor.d/local/

		permission_files=("/etc/apparmor.d/local/abstractions/libvirt-qemu" "/etc/apparmor.d/local/usr.sbin.libvirtd" "/etc/apparmor.d/local/usr.lib.libvirt.virt-aa-helper")
		for set_permission in ${permission_files[@]}; do
			echo "/var/tmp/virtnbdbackup.* rw,
            /var/tmp/backup.* rw," >>$set_permission
		done

		cd $current_dir
		echo -e "\n${Green}${CHECK}virtnbdbackup installed successfully ${NC}"
	fi

	echo "package_name                    status"
	echo "------------------------------------------"
	echo "virtnbdbackup                  Installed"
}
function main() {
	apt_update_repo_check
	packages=(python3-paramiko bc libncurses5 nfs-common rsync python3-pip python3-all python3-stdeb dh-python python3-libnbd python3-tqdm python3-lz4 python3-lxml nbdkit libnbd-bin tmux)
	for package in "${packages[@]}"; do
		if [[ "$package" == "openvswitch-switch" ]] && dpkg -s "$package" &>/dev/null; then
			echo -e "${Green}$package [Installed - Skipping Upgrade]${CHECK}${NC}"
			continue
		fi
		echo -e "${Green}Checking $package package${NC}"
		echo -e "Please Wait... ⏳ (This can take a while)"
		if ! sudo apt install "$package" -y &>/dev/null; then
			echo "There's a problem installing or upgrading $package." >&2
			exit 2
		else
			echo -e "${Green}$package [Installed/Updated]${CHECK}${NC}"
		fi
	done

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

	set_sshd "TCPKeepAlive" "yes"
	set_sshd "ClientAliveInterval" "30"
	set_sshd "ClientAliveCountMax" "10"

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
        END {}
        ' "$SSH_FILE" >/tmp/ssh_config.tmp && mv /tmp/ssh_config.tmp "$SSH_FILE"

			echo "➕ ssh: added $key"
		fi
	}

	ensure_client_setting "ServerAliveInterval" "30"
	ensure_client_setting "ServerAliveCountMax" "10"
	ensure_client_setting "TCPKeepAlive" "yes"

	# =========================
	# validate + restart safely
	# =========================
	sshd -t

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
