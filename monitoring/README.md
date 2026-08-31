# Backup Manager → Grafana — handover pack

Everything needed to build the two Grafana dashboards and their alerts.
Send this whole `monitoring/` directory.

| File | What it is |
|---|---|
| `grafana-dashboard-vms.json` | Dashboard 1 — virtual machines. Import into Grafana. |
| `grafana-dashboard-infra.json` | Dashboard 2 — backup hosts & hypervisors. Import into Grafana. |
| `grafana-alerts.yaml` | 10 alert rules, Grafana provisioning format. |
| `grafana-dashboard-mockup.html` | What the finished dashboards should look like. Open in a browser. |
| `telegraf-backup-manager.conf` | Telegraf drop-in (already installed on the relay host). |
| `telegraf.conf` | Reference copy of the relay host's main Telegraf config. |
| `install-backup-metrics.sh` | Installs/repairs the Telegraf side. Already run. |
| `../docs/METRICS.md` | Full metric reference — every metric, label and unit. |

---

## 1. Where the data comes from

```
Backup controller  ──HTTPS + bearer token──▶  Telegraf  ──plain HTTP──▶  Prometheus
 (10.0.0.10)                          (relay host)                   (yours)
 renders /metrics                         port 9274
```

The backup controller publishes Prometheus metrics. Telegraf on the relay host
scrapes it every 30s and re-exposes everything on **port 9274**. Prometheus
scrapes Telegraf.

**Prometheus needs no credentials.** The bearer token is only used on the
controller → Telegraf hop, and Telegraf already holds it. Port 9274 is plain
HTTP on the internal network.

Port **9273** on the same host is the pre-existing OS/724 Telegraf output and is
unrelated — it carries no `bm_*` metrics (`namedrop` keeps them out).

Both the Telegraf input and the `:9274` output run `metric_version = 1`, which
is what makes the metric names arrive in Prometheus exactly as the controller
published them. The two must always match; see `telegraf-backup-manager.conf`.

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: backup-manager
    scrape_interval: 30s
    static_configs:
      - targets: ['<relay-host>:9274']
```

About **2,500 series**, all prefixed `bm_`. Cardinality is bounded by fleet size —
no job IDs, no error strings, no timestamps in labels.

---

## 2. Auth

| Hop | Auth |
|---|---|
| Prometheus → Telegraf `:9274` | none (internal network) |
| Telegraf → controller `/metrics` | `Authorization: Bearer <METRICS_TOKEN>` |
| TLS to the controller | internal certificate, `insecure_skip_verify = true` |

The token lives in `/etc/telegraf/telegraf.d/telegraf-backup-manager.conf` as
`bearer_token_string`, and in the controller's `.env` as `METRICS_TOKEN`. It is
**not** in this repo — ask the backup team if you need it.

`install-backup-metrics.sh` reads both values from the project's own `.env`
files, so nothing has to be typed by hand:

| Value | Read from |
|---|---|
| scrape token | `controller-backend/.env` → `METRICS_TOKEN` |
| metrics URL | `frontend/.env` → `VITE_BACKEND_URL` + `/metrics/prometheus` |

`--token` and `--url` override them. If a value is missing, empty or still a
placeholder, the script stops and names the exact file and line to fix.

`insecure_skip_verify` is deliberate: Go's TLS stack has no "verify but tolerate
expiry" mode, and one of the metrics published here is certificate expiry. With
verification on, the pipeline would die exactly when it had something to report.

---

## 3. Install

**Dashboards** — Grafana → Dashboards → New → Import → upload the JSON → pick
your Prometheus data source. The `DS` variable inside each dashboard handles the
binding, so nothing has to be edited by hand.

**Alerts** — replace every `PROM_UID` in `grafana-alerts.yaml` with your
Prometheus data source UID, then:

```bash
cp grafana-alerts.yaml /etc/grafana/provisioning/alerting/backup-manager.yaml
systemctl restart grafana-server
```

Rules carry `severity`, `team: backup` and `service: backup-manager` labels —
route them through your existing notification policies. Contact points are not
defined here.

---

## 4. Dashboard 1 — Virtual machines

Six headline stats, then a **job history table mirroring the backup panel's own
history view** (Type, VM, Method, Status, Progress, Duration, Exit, Started,
Offsite), then detail panels.

One difference from the application's history view worth knowing: Prometheus
holds *current state*, not a list of jobs. Each row is that VM's **most recent
run**, not one row per historical job. A scrollable per-job history would need
Loki or a SQL data source, not Prometheus.

| Panel | Answers |
|---|---|
| Protected / Unprotected | Is anything not being backed up at all? |
| Overdue | Which VMs are past **their own** schedule interval? |
| Never backed up | Which scheduled VMs have never once succeeded? |
| Running / Queued | What is happening right now? |
| Offsite partial / failed | Which offsite copies are incomplete? |
| Job history | The panel's history view, as a dashboard |
| RPO budget used | Who is furthest past their deadline? |
| Outcomes 24h | Success/failure mix |
| In flight | Live progress bars |
| Offsite destinations not synced | Which destination is broken? |
| Backup duration | Trend, for capacity planning |

## 5. Dashboard 2 — Backup hosts & hypervisors

Reachability, capacity, and whether the figures are still being collected.
Hypervisor CPU/RAM is deliberately excluded — that is the virtualisation team's
dashboard.

---

## 6. Five things that will bite you

**`up{}` does NOT tell you the controller is alive.** Prometheus scrapes
Telegraf, so `up` reports Telegraf. If the controller dies while Telegraf keeps
running, `up` stays 1. Use instead:

```promql
time() - bm_scrape_timestamp_seconds > 600
```

That is the controller's own clock stamp; it stops advancing when collection
stops. The `bm-metrics-stale` alert rule covers it. **While that fires, every
other backup alert is blind.**

**Absent is not zero.** A VM that has never completed a backup publishes *no*
`bm_vm_backup_last_success_timestamp_seconds` series at all. Age-based queries
cannot see it — it looks healthier than a VM one hour late. That is why the
"never backed up" panel and the `unless on(vm)` alert exist.

**Partial offsite is not success.** `bm_vm_offsite_last_status == 1` means some
destinations hold the VM and some do not. Never fold it into "failed vs
everything else"; colour it orange.

**Series linger for 5 minutes.** Telegraf's `expiration_interval` replaces
Prometheus staleness handling, so a removed VM keeps reporting its last values
for 5 minutes. Any "no data" alert needs `for:` longer than that.

**Counters reset on controller restart.** `bm_backup_runs_total` and friends are
in-memory. `rate()`/`increase()` handle this; for plain windowed counts use
`bm_vm_backup_runs_24h`, which is recomputed from stored history.
`bm_controller_start_timestamp_seconds` shows when the last reset happened.

---

## 7. Alerts included

| Rule | Expression | For | Severity |
|---|---|---|---|
| Backup failed | `bm_vm_backup_last_status == 1` | 10m | critical |
| Backup failing repeatedly | `bm_vm_backup_consecutive_failures >= 3` | 10m | critical |
| Backup overdue | last success older than the VM's own interval | 15m | critical |
| VM never backed up | `bm_vm_protected == 1 unless on(vm) …last_success…` | 1h | critical |
| Backup stuck | `bm_vm_backup_stuck == 1` | 30m | warning |
| Offsite replication incomplete | `…offsite_last_status == 1 or == 2` | 1h | warning |
| Offsite destination failing | `bm_vm_offsite_target_status == 2` | 1h | warning |
| Backup host offline | `bm_backup_host_up == 0` | 10m | critical |
| Storage nearly full | `bm_storage_pool_usage_ratio > 0.90` | 30m | critical |
| Metrics not being collected | `time() - bm_scrape_timestamp_seconds > 600` | 10m | critical |

---

## 8. Status encodings

Small integers, so each VM keeps one series. Mappings are already in the
dashboard JSON; you only need these if you build extra panels.

**`bm_vm_backup_last_status`** — 0 completed · 1 failed · 2 skipped ·
3 rejected · 4 running · 5 queued · 6 cancelled · 7 retrying · -1 unknown

**`bm_vm_offsite_last_status`** — 0 replicated · 1 partial · 2 failed ·
3 running · 4 retrying · 5 unknown

**`bm_vm_offsite_target_status`** — 0 synced · 1 skipped · 2 failed

---

## 9. Labels

`vm`, `hypervisor`, `backup_host`, `offsite_host`, `pool`, `path`, `schedule`,
`method`, `result`.

Telegraf adds `url` (the controller it scraped) to every series — include it in
`by()` clauses or hide it in tables. The Telegraf host's own `host` tag is
stripped.

---

Questions about what a metric *means* → backup team.
Questions about panel construction → monitoring team.
Full reference: `docs/METRICS.md`.
