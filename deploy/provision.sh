#!/usr/bin/env bash
#
# deploy/provision.sh
#
# Turns a bare Ubuntu 26.04 box into one that can run deploy/docker-compose.yml:
# firewall, fail2ban, unattended upgrades, keys-only SSH, swap, and Docker —
# plus the /srv/framecast directory tree with the ownership the app and
# worker containers require. See docs/vps-deployment.md for the full
# procedure this script is one part of, including what it deliberately does
# NOT do and why (an interactive unattended-upgrades prompt, and writing the
# environment files, which hold secrets and are never scripted or committed).
#
# Run as root, on the server itself, after copying this file to it — it is
# not meant to be piped from a raw GitHub URL, and it is not run from a repo
# checkout on the box (see deploy/README.md: "copied to the server, not run
# in place").
#
# Idempotent: every step here is safe to re-run against a box this script
# already provisioned — re-running should converge on the same end state,
# never break a working one. That matters because this is also the recovery
# procedure after a rebuild, and a 2am rebuild is not the moment to first
# discover that re-running it wedges the box.
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

echo "==> Step 1a: updating packages"
apt-get update
apt-get upgrade -y

echo "==> Step 1b: installing ufw, fail2ban, unattended-upgrades"
apt-get install -y ufw fail2ban unattended-upgrades
systemctl enable --now fail2ban

echo "==> Step 1c: firewall — SSH, HTTP, HTTPS only"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Step 1d: switching SSH to keys only"
# Safety gate, not a substitute for the manual check: refuses to disable
# password auth if no key is on file for root, so a mistaken run of this
# script cannot lock out the only working way in. It cannot prove a key
# *works* (permissions, agent forwarding, wrong key pushed) — that still
# needs a human confirming a keyed login succeeds in a second terminal
# BEFORE this script runs. See docs/vps-deployment.md, Step 1.
if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "ERROR: /root/.ssh/authorized_keys is empty or missing." >&2
  echo "Disabling password auth now would lock this box permanently." >&2
  echo "Run 'ssh-copy-id root@<host>' from your workstation first, confirm" >&2
  echo "you can log in with the key, then re-run this script." >&2
  exit 1
fi

# Written as a drop-in, not as a sed against /etc/ssh/sshd_config, because on
# Ubuntu 26.04 that sed is very likely a no-op. The shipped sshd_config opens
# with `Include /etc/ssh/sshd_config.d/*.conf`, and OpenSSH keeps the FIRST
# value it sees for a keyword — so a cloud-init or OVH drop-in carrying
# `PasswordAuthentication yes` is read before anything in the main file and
# silently wins, no matter what the sed wrote.
#
# The same first-wins rule is why this file is 00-, not 99-: the Include glob
# expands in lexical order, so `99-framecast.conf` would lose to a
# `50-cloud-init.conf` exactly the way the main file does. 00- sorts ahead of
# every numeric drop-in these images ship.
#
# The main file is still sed'ed below, for a box whose sshd_config has no
# Include line at all. Neither mechanism is trusted: the `sshd -T` assertion
# after the reload is what actually decides whether this step succeeded.
install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/00-framecast.conf <<'SSHD'
# Managed by deploy/provision.sh — see docs/vps-deployment.md, Step 1.
# Named 00- deliberately: OpenSSH honours the first value it reads for a
# keyword, and Include expands this directory in lexical order.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
chmod 644 /etc/ssh/sshd_config.d/00-framecast.conf

sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

# Refuse to reload a config sshd itself rejects — a reload onto a syntax error
# is how a box ends up with no listening sshd and no way back in.
sshd -t
systemctl reload ssh

# The actual check. `sshd -T` prints the *effective* configuration after every
# Include has been resolved, which is the only thing that answers "did the
# hardening take". Anything else — grepping the file we just wrote, trusting
# the sed — confirms what we asked for, not what sshd will do.
echo "==> Verifying the effective SSH config"
EFFECTIVE="$(sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) ')"
echo "$EFFECTIVE"

if ! grep -qx 'passwordauthentication no' <<<"$EFFECTIVE" ||
   ! grep -qx 'permitrootlogin prohibit-password' <<<"$EFFECTIVE"; then
  echo "ERROR: SSH hardening did not take effect." >&2
  echo "Expected 'passwordauthentication no' and 'permitrootlogin prohibit-password'." >&2
  echo "Something is setting these earlier than /etc/ssh/sshd_config.d/00-framecast.conf." >&2
  echo "Find it — OpenSSH keeps the first value it reads:" >&2
  grep -rniE '^[[:space:]]*(PasswordAuthentication|PermitRootLogin)' \
    /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ >&2 || true
  echo "Password login is still enabled on this box. Fix this before continuing." >&2
  exit 1
fi

echo "==> Step 1e: unattended-upgrades"
echo "    Not scripted — 'dpkg-reconfigure -plow unattended-upgrades' is an"
echo "    interactive prompt. Run it by hand once; see docs/vps-deployment.md."

echo "==> Step 2: swap"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
else
  echo "    /swapfile already exists, leaving its contents alone"
  swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Prefer reclaiming page cache to swapping a live process.
sysctl -w vm.swappiness=10 >/dev/null
if grep -q '^vm.swappiness=' /etc/sysctl.conf; then
  sed -i 's/^vm.swappiness=.*/vm.swappiness=10/' /etc/sysctl.conf
else
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

echo "==> Step 3: Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "    Docker already installed, skipping install"
fi
docker --version
docker compose version

echo "==> Step 4: directory tree"
mkdir -p /srv/framecast/{postgres,env}
mkdir -p /srv/framecast/prod/{storage,renders}
mkdir -p /srv/framecast/staging/{storage,renders}
chmod 700 /srv/framecast/env

# app-prod, worker-prod, app-staging and worker-staging all run as UID:GID
# 1001:1001 (deploy/docker-compose.yml's `user:` on each, backed by
# app/Dockerfile and worker/Dockerfile). Docker creates a bind-mount source
# that doesn't already exist as root:root, and so does a directory this
# script's own `mkdir -p` just created. A container running as UID 1001 can
# *read* a root-owned directory but cannot write or delete inside one —
# unlinking a file needs write permission on the directory, not the file.
# Left unfixed, the post-publish render reclaim in publish.service.ts fails
# silently on every publish (it only logs a warning nobody is watching),
# finished renders are never reclaimed, and the 40GB disk fills exactly the
# way Task 5 exists to prevent. Re-running this chown is harmless — it's
# idempotent by nature — which is also why it's safe to leave in a script
# meant to be re-run rather than treated as a one-off command to remember.
#
# Postgres is excluded on purpose: postgres:17-alpine's entrypoint starts as
# root and chowns its own data directory to the postgres user internally
# before dropping privileges, every time it finds one it doesn't already own.
chown -R 1001:1001 /srv/framecast/prod /srv/framecast/staging

echo "==> Verifying ownership (expect 1001:1001 on both lines)"
stat -c '%u:%g %n' /srv/framecast/prod/renders /srv/framecast/staging/renders

cat <<'EOF'

==> Provisioning script finished.

Remaining steps are manual by design — see docs/vps-deployment.md:
  1. Run `dpkg-reconfigure -plow unattended-upgrades` (interactive).
  2. Write /srv/framecast/env/prod.env and staging.env from
     deploy/prod.env.example and deploy/staging.env.example. These hold
     secrets: write them by hand on the server, never script or commit them.
  3. Copy deploy/docker-compose.yml, deploy/Caddyfile and
     deploy/init-staging-db.sh to /srv/framecast/, then follow Tasks 10-12
     of the runbook to bring the stack up.
EOF
