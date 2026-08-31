#!/usr/bin/env bash
#
# Install the Backup Manager -> Telegraf -> Prometheus relay.
#
# Safe to re-run: every step is idempotent, and the existing OS / 724 monitoring
# on :9273 is preserved. What it does, in order:
#
#   1. Backs up /etc/telegraf/telegraf.conf and /etc/telegraf/telegraf.d/.
#   2. Removes any [[inputs.prometheus]] block, and any :9274
#      [[outputs.prometheus_client]] block, from the MAIN config. Those belong
#      in telegraf.d/ only; a stray copy in the main file collects everything a
#      second time.
#   3. Adds namedrop = ["bm_*"] to the :9273 output, so the backup metrics do
#      not also leave through the :9273 output as a duplicate copy.
#   4. Installs telegraf-backup-manager.conf into telegraf.d/ with the URL and
#      token substituted, mode 0640 (it holds the scrape token).
#   5. Verifies with `telegraf --test` BEFORE reloading, and refuses to reload
#      if the check fails.
#   6. Reloads Telegraf and confirms both :9273 and :9274 are serving.
#
# The token and URL are read from the project's own .env files, so there is
# nothing to type in the normal case:
#
#   controller-backend/.env   METRICS_TOKEN      -> the scrape token
#   frontend/.env             VITE_BACKEND_URL   -> the panel's API base URL,
#                                                   + /metrics/prometheus
#
# Both can be overridden on the command line. If neither the file nor a flag
# supplies a value, the script stops and says exactly which line to fill in.
#
# Usage:
#   sudo ./install-backup-metrics.sh [options]
#
#   --token   <t>   Override METRICS_TOKEN from controller-backend/.env
#   --url     <u>   Override the URL derived from frontend/.env
#   --dry-run       Show what would change; write nothing, reload nothing.
#   --no-reload     Apply the files and verify, but leave the reload to you.

set -euo pipefail

TELEGRAF_CONF="${TELEGRAF_CONF:-/etc/telegraf/telegraf.conf}"
TELEGRAF_D="${TELEGRAF_D:-/etc/telegraf/telegraf.d}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROPIN_SRC="$SRC_DIR/telegraf-backup-manager.conf"
DROPIN_DST="$TELEGRAF_D/telegraf-backup-manager.conf"

REPO_ROOT="$(cd "$SRC_DIR/.." && pwd)"
CONTROLLER_ENV="${CONTROLLER_ENV:-$REPO_ROOT/controller-backend/.env}"
FRONTEND_ENV="${FRONTEND_ENV:-$REPO_ROOT/frontend/.env}"

METRICS_URL=""
TOKEN=""
DRY_RUN=0
DO_RELOAD=1

# Read KEY=value out of a .env file: last assignment wins, `export` prefix and
# surrounding quotes are tolerated, commented-out lines are ignored, and a
# trailing ` # comment` is stripped. Returns non-zero when there is no value,
# so callers can distinguish "absent" from "present but empty".
read_env() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | tail -1)"
  [[ -n "$line" ]] || return 1
  line="${line#*=}"
  line="$(printf '%s' "$line" \
    | sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
  [[ -n "$line" ]] || return 1
  printf '%s' "$line"
}

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }
step() { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$OFF"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)    TOKEN="${2:-}"; shift 2 ;;
    --url)      METRICS_URL="${2:-}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --no-reload) DO_RELOAD=0; shift ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *)          die "Unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
step "Preflight"

[[ -f "$DROPIN_SRC" ]] || die "Not found: $DROPIN_SRC (run this from the repo's monitoring/ directory)"
[[ -f "$TELEGRAF_CONF" ]] || die "Not found: $TELEGRAF_CONF"
command -v telegraf >/dev/null || die "telegraf is not installed"
[[ $DRY_RUN -eq 1 || $EUID -eq 0 ]] || die "Run as root (writes under /etc/telegraf)"

# ---- Token: --token > controller-backend/.env > whatever is already installed
if [[ -n "$TOKEN" ]]; then
  ok "Token: from --token"
elif TOKEN="$(read_env "$CONTROLLER_ENV" METRICS_TOKEN)"; then
  ok "Token: read from $CONTROLLER_ENV"
elif [[ -f "$DROPIN_DST" ]] && TOKEN="$(sed -n 's/^[[:space:]]*bearer_token_string[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$DROPIN_DST" | head -1)" && [[ -n "$TOKEN" ]]; then
    ok "Token: reusing the one already in $DROPIN_DST"
else
  if [[ -f "$CONTROLLER_ENV" ]]; then
    die "METRICS_TOKEN is missing or empty in $CONTROLLER_ENV.
     Generate one and add it, then restart the controller:
         openssl rand -hex 32
         echo 'METRICS_TOKEN=<the value>' >> $CONTROLLER_ENV
     Or pass it here with --token <value>."
  fi
  die "Could not find a token.
     $CONTROLLER_ENV does not exist on this host, so METRICS_TOKEN cannot be
     read from it. Pass the controller's METRICS_TOKEN with --token <value>,
     or point CONTROLLER_ENV at the right file:
         CONTROLLER_ENV=/path/to/controller-backend/.env $0"
fi

case "$TOKEN" in
  *...*|REPLACE_WITH_*|changeme|CHANGEME)
    die "That token is a placeholder, not a real value: $TOKEN
     Set a real METRICS_TOKEN in $CONTROLLER_ENV (openssl rand -hex 32)." ;;
esac

# ---- URL: --url > frontend/.env VITE_BACKEND_URL + the metrics path --------
# VITE_BACKEND_URL is the panel's API base (e.g. https://host/api-backup), and
# the controller serves the exposition at <base>/metrics/prometheus — the same
# path the browser app already reaches through nginx, so if the panel works,
# this URL works.
if [[ -n "$METRICS_URL" ]]; then
  ok "URL: from --url"
elif BACKEND_URL="$(read_env "$FRONTEND_ENV" VITE_BACKEND_URL)"; then
  case "$BACKEND_URL" in
    *you-domain.com*|*your-domain*|*example.com*|*localhost*)
      die "VITE_BACKEND_URL in $FRONTEND_ENV is still a placeholder:
         $BACKEND_URL
     Set the panel's real URL there, or pass --url <metrics url> here." ;;
  esac
  METRICS_URL="${BACKEND_URL%/}/metrics/prometheus"
  ok "URL: derived from VITE_BACKEND_URL in $FRONTEND_ENV"
else
  if [[ -f "$FRONTEND_ENV" ]]; then
    die "VITE_BACKEND_URL is missing or empty in $FRONTEND_ENV.
     It should hold the panel's API base, for example:
         VITE_BACKEND_URL=https://backup.example.com/api-backup
     Or pass the metrics URL directly with --url <url>."
  fi
  die "Could not determine the metrics URL.
     $FRONTEND_ENV does not exist on this host, so VITE_BACKEND_URL cannot be
     read from it. Pass the URL with --url, for example:
         --url https://backup.example.com/api-backup/metrics/prometheus"
fi

ok "telegraf $(telegraf --version 2>/dev/null | awk '{print $2}')"
ok "URL: $METRICS_URL"

# Prove the endpoint answers before rearranging any config. A 401 here is a
# token mismatch; HTML is nginx serving the SPA because the path is wrong.
step "Checking the metrics endpoint"
http_code="$(curl -sk -o /tmp/bm-metrics-probe.$$ -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$METRICS_URL" || true)"
probe_lines="$(grep -c '^bm_' /tmp/bm-metrics-probe.$$ 2>/dev/null || true)"
rm -f /tmp/bm-metrics-probe.$$

case "$http_code" in
  200) [[ "${probe_lines:-0}" -gt 0 ]] \
         && ok "HTTP 200, ${probe_lines} bm_* series" \
         || die "HTTP 200 but no bm_* series — is that the metrics URL, or the SPA?" ;;
  401) die "HTTP 401 — the token does not match METRICS_TOKEN on the controller" ;;
  000) die "Could not connect to $METRICS_URL" ;;
  *)   die "HTTP $http_code from $METRICS_URL" ;;
esac

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------
step "Backing up the current config"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/telegraf-backup-$STAMP"
if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$BACKUP_DIR"
  cp -a "$TELEGRAF_CONF" "$BACKUP_DIR/"
  [[ -d "$TELEGRAF_D" ]] && cp -a "$TELEGRAF_D" "$BACKUP_DIR/"
  ok "Saved to $BACKUP_DIR"
else
  say "  (dry run) would back up to $BACKUP_DIR"
fi

# ---------------------------------------------------------------------------
# Clean the main config
#
# Blocks are delimited by lines starting with [[ ; everything from a [[header]]
# up to the next [[header]] belongs to that block. Two kinds are removed:
# any prometheus INPUT (belongs in telegraf.d/ only) and any prometheus_client
# OUTPUT bound to :9274 (likewise). The :9273 output is never touched here.
# ---------------------------------------------------------------------------
step "Cleaning $TELEGRAF_CONF"

CLEANED="$(mktemp)"
awk '
  # A block is a [[header]] plus its body. A run of comment/blank lines is
  # attached to the block that FOLLOWS it, not the one before — otherwise the
  # banner comment above an [[inputs.prometheus]] block counts as part of the
  # previous output block, and removing it either drags that output away or
  # leaves the banner behind as orphaned text. Both happened before this.
  function is_comment(l) { return l ~ /^[[:space:]]*(#|$)/ }
  function flush_block(   i, drop) {
    if (nbuf == 0) return
    drop = (header == "[[inputs.prometheus]]") ||
           (header == "[[outputs.prometheus_client]]" && block_is_9274)
    if (drop) removed++
    else for (i = 1; i <= nbuf; i++) print buf[i]
    nbuf = 0; block_is_9274 = 0
  }
  /^[[:space:]]*\[\[/ {
    # Peel the trailing comment run off the current block; it introduces this
    # one. Everything before it is flushed under the old header.
    k = nbuf
    while (k > 0 && is_comment(buf[k])) k--
    ncarry = 0
    for (i = k + 1; i <= nbuf; i++) carry[++ncarry] = buf[i]
    nbuf = k
    flush_block()
    header = $0
    sub(/^[[:space:]]+/, "", header); sub(/[[:space:]]+$/, "", header)
    for (i = 1; i <= ncarry; i++) buf[++nbuf] = carry[i]
    buf[++nbuf] = $0
    next
  }
  # Only a real listen directive marks the block as the :9274 output. Matching
  # "9274" anywhere would let a passing mention in a comment condemn a block.
  /^[[:space:]]*listen[[:space:]]*=.*9274/ { block_is_9274 = 1 }
  { buf[++nbuf] = $0 }
  END { flush_block(); printf("%d", removed) > "/dev/stderr" }
' "$TELEGRAF_CONF" > "$CLEANED" 2>"$CLEANED.count"
REMOVED="$(cat "$CLEANED.count")"; rm -f "$CLEANED.count"

if [[ "${REMOVED:-0}" -gt 0 ]]; then
  warn "Removing $REMOVED stray prometheus block(s) from the main config"
else
  ok "No stray prometheus blocks in the main config"
fi

# Add namedrop to the :9273 output when it is not already there.
if grep -q 'namedrop.*bm_\*' "$CLEANED"; then
  ok 'namedrop = ["bm_*"] already present on the :9273 output'
elif grep -q 'listen[[:space:]]*=[[:space:]]*":9273"' "$CLEANED"; then
  awk '
    /listen[[:space:]]*=[[:space:]]*":9273"/ {
      print
      print ""
      print "  # Keep the Backup Manager metrics out of this output; they leave through"
      print "  # the dedicated :9274 output on its own. Without this line they would"
      print "  # ALSO be rendered here at version 1, arriving as a mangled duplicate."
      print "  namedrop = [\"bm_*\"]"
      next
    }
    { print }
  ' "$CLEANED" > "$CLEANED.new" && mv "$CLEANED.new" "$CLEANED"
  ok 'Added namedrop = ["bm_*"] to the :9273 output'
else
  warn "No :9273 output found — skipping namedrop (check this file by hand)"
fi

# Sanity: the OS inputs must still be there. If this file was overwritten at
# some point rather than appended to, stop rather than cement the damage.
for plugin in inputs.cpu inputs.disk inputs.mem inputs.system outputs.prometheus_client; do
  grep -q "^\[\[$plugin\]\]" "$CLEANED" \
    || die "[[$plugin]] is missing from $TELEGRAF_CONF — restore it from $BACKUP_DIR (or monitoring/telegraf.conf) before re-running"
done
ok "OS and 724 inputs intact"

# ---------------------------------------------------------------------------
# Render the drop-in
# ---------------------------------------------------------------------------
step "Rendering $DROPIN_DST"

RENDERED="$(mktemp)"
TOKEN="$TOKEN" METRICS_URL="$METRICS_URL" awk '
  /^[[:space:]]*urls[[:space:]]*=/ && !done_url {
    printf("  urls = [\"%s\"]\n", ENVIRON["METRICS_URL"]); done_url = 1; next
  }
  /^[[:space:]]*bearer_token_string[[:space:]]*=/ {
    printf("  bearer_token_string = \"%s\"\n", ENVIRON["TOKEN"]); next
  }
  { print }
' "$DROPIN_SRC" > "$RENDERED"

grep -q "$METRICS_URL" "$RENDERED" || die "URL substitution failed"
grep -q "$TOKEN" "$RENDERED"       || die "Token substitution failed"
# Telegraf only round-trips the exposition unchanged when the input and the
# output agree on metric_version, and namepass = ["bm_*"] additionally requires
# version 1 (where the metric name IS the measurement name). Assert both, so a
# half-edited file cannot reach a reload.
mv_count="$(grep -c '^[[:space:]]*metric_version[[:space:]]*=[[:space:]]*1[[:space:]]*$' "$RENDERED" || true)"
if grep -qE '^[[:space:]]*metric_version[[:space:]]*=[[:space:]]*2[[:space:]]*$' "$RENDERED"; then
  die "The drop-in still sets metric_version = 2 somewhere. It must be 1 in BOTH
     the [[inputs.prometheus]] and the [[outputs.prometheus_client]] blocks —
     namepass matches measurement names, and only version 1 makes the metric
     name the measurement name."
fi
[[ "${mv_count:-0}" -eq 2 ]] || die "Expected metric_version = 1 in both the input and the output block of
     $DROPIN_SRC, found $mv_count." 
ok "URL and token substituted"

if [[ $DRY_RUN -eq 1 ]]; then
  step "Dry run — nothing written"
  say "Would write: $TELEGRAF_CONF"
  diff -u "$TELEGRAF_CONF" "$CLEANED" || true
  say ""
  say "Would write: $DROPIN_DST (0640)"
  rm -f "$CLEANED" "$RENDERED"
  exit 0
fi

install -m 0644 "$CLEANED" "$TELEGRAF_CONF"

# 0640 keeps the scrape token out of a world-readable file, but the daemon runs
# as its own unprivileged user (USER=telegraf in the init script), so the GROUP
# must be that user or Telegraf cannot read its own config and refuses to start
# with "permission denied" — silently, from the installer's point of view.
TELEGRAF_USER="$(grep -oP '^USER=\K\S+' /etc/init.d/telegraf 2>/dev/null | head -1)"
[[ -n "$TELEGRAF_USER" ]] || TELEGRAF_USER="$(systemctl show -p User --value telegraf 2>/dev/null)"
[[ -n "$TELEGRAF_USER" ]] || TELEGRAF_USER="telegraf"

if id -u "$TELEGRAF_USER" >/dev/null 2>&1; then
  install -m 0640 -g "$TELEGRAF_USER" "$RENDERED" "$DROPIN_DST"
  if sudo -u "$TELEGRAF_USER" test -r "$DROPIN_DST" 2>/dev/null; then
    ok "Config written (0640 root:$TELEGRAF_USER — readable by the daemon)"
  else
    warn "$TELEGRAF_USER still cannot read $DROPIN_DST; widening to 0644"
    chmod 0644 "$DROPIN_DST"
    warn "The scrape token is now world-readable in that file."
  fi
else
  # No dedicated user: the daemon runs as root, so 0640 root:root is readable.
  install -m 0640 "$RENDERED" "$DROPIN_DST"
  ok "Config written (0640 root:root — no '$TELEGRAF_USER' user on this host)"
fi
rm -f "$CLEANED" "$RENDERED"

# ---------------------------------------------------------------------------
# Verify BEFORE reloading
# ---------------------------------------------------------------------------
step "Verifying the config (no reload yet)"

TEST_OUT="$(mktemp)"
telegraf --config "$TELEGRAF_CONF" --config-directory "$TELEGRAF_D" \
         --test --input-filter prometheus >"$TEST_OUT" 2>&1 || true

if grep -qE '^\S+ E! ' "$TEST_OUT"; then
  grep -E '^\S+ E! ' "$TEST_OUT" | head -5
  rm -f "$TEST_OUT"; die "Telegraf reported errors — nothing reloaded, config is on disk for inspection"
fi

# Exactly one prometheus input must be loaded. Two means a stray copy survived
# somewhere and every series would be collected twice.
inputs_line="$(grep -o 'Loaded inputs:.*' "$TEST_OUT" | head -1 || true)"
case "$inputs_line" in
  *"prometheus (2x)"*|*"prometheus (3x)"*) rm -f "$TEST_OUT"; die "More than one prometheus input loaded: $inputs_line" ;;
  *prometheus*) ok "$inputs_line" ;;
  *) rm -f "$TEST_OUT"; die "No prometheus input loaded" ;;
esac

# The decisive check. metric_version 1 makes the METRIC NAME the measurement,
# so lines read "> bm_foo,... gauge=1"; version 2 puts everything under one
# "prometheus" measurement and reads "> prometheus,... bm_foo=1". Both are
# valid Telegraf, but namepass = ["bm_*"] on the output matches the MEASUREMENT
# name — so under version 2 it matches nothing and :9274 serves an empty page
# while --test still looks perfectly healthy.
named_count="$(grep -c '^> bm_' "$TEST_OUT" || true)"
lumped_count="$(grep -c '^> prometheus,' "$TEST_OUT" || true)"
if [[ "${lumped_count:-0}" -gt 0 ]]; then
  rm -f "$TEST_OUT"
  die "Metrics are in metric_version 2 shape ('> prometheus,...'), but namepass matches measurement names. Set metric_version = 1 on BOTH the input and the :9274 output."
fi
[[ "${named_count:-0}" -gt 0 ]] || { rm -f "$TEST_OUT"; die "No bm_* metrics collected"; }
ok "$named_count series in metric_version 1 shape (measurement = metric name)"
rm -f "$TEST_OUT"

if [[ $DO_RELOAD -eq 0 ]]; then
  step "Done (reload skipped)"
  say "Apply when ready:  systemctl restart telegraf   (this unit has no reload verb)"
  exit 0
fi

chown telegraf:telegraf /etc/telegraf/telegraf.conf
chmod 0640 /etc/telegraf/telegraf.conf
# ---------------------------------------------------------------------------
# Reload and confirm both pipelines
# ---------------------------------------------------------------------------
step "Reloading Telegraf"

# This host ships Telegraf as an LSB init script wrapped by systemd, and such
# units have no reload verb ("Job type reload is not applicable"). Fall back to
# a restart, and do not treat the failed reload as an error.
if systemctl reload telegraf 2>/dev/null; then
  ok "Reloaded"
else
  systemctl restart telegraf
  ok "Restarted (this unit has no reload verb)"
fi

# Both ports are EMPTY immediately after a restart, and that is normal: an
# output only has series once its inputs have collected at least once. The
# backup input runs every 30s and the OS inputs inherit the 1m [agent]
# interval, so a fixed `sleep 5` reported failure on a perfectly healthy
# restart. Poll instead, up to two minutes.
say "  waiting for the first collection cycle (up to 2 min)…"
old_count=0; new_count=0
for _ in $(seq 1 24); do
  old_count="$(curl -s --max-time 5 localhost:9273/metrics | grep -cE '^(cpu|mem|disk|system)_' || true)"
  new_count="$(curl -s --max-time 5 localhost:9274/metrics | grep -c '^bm_' || true)"
  [[ "${old_count:-0}" -gt 0 && "${new_count:-0}" -gt 0 ]] && break
  sleep 5
done

fail=0
leak_count="$(curl -s --max-time 10 localhost:9273/metrics | grep -c 'bm_' || true)"

[[ "${old_count:-0}" -gt 0 ]] && ok ":9273 still serving OS metrics ($old_count series)" \
  || { warn ":9273 returned no OS metrics after 2 min — check: pgrep -a telegraf; tail -40 /var/log/telegraf/telegraf.log"; fail=1; }

[[ "${new_count:-0}" -gt 0 ]] && ok ":9274 serving backup metrics ($new_count series)" \
  || { warn ":9274 returned no bm_* metrics after 2 min — check: tail -40 /var/log/telegraf/telegraf.log"; fail=1; }

[[ "${leak_count:-0}" -eq 0 ]] && ok ":9273 is clean of bm_* duplicates" \
  || { warn ":9273 still carries $leak_count bm_* series — the namedrop line is not taking effect"; fail=1; }

step "Result"
if [[ $fail -eq 0 ]]; then
  ok "Both pipelines healthy. Add localhost:9274 as a second Prometheus target on this host."
  say "  Backup of the previous config: $BACKUP_DIR"
else
  die "Finished with warnings above. Restore with: cp -a $BACKUP_DIR/telegraf.conf $TELEGRAF_CONF && systemctl restart telegraf"
fi
