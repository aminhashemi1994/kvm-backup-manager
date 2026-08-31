# Prometheus metrics for Grafana

The controller exposes its state in the Prometheus text exposition format for
Grafana dashboards and alerting.

```
GET https://<controller>/metrics
GET https://<controller>/api/metrics/prometheus     # same content, for /api-only proxies
```

Alert rules are **not** defined here — every threshold the monitoring team needs
is published as a metric so the rules live in Grafana where they belong.

## Scrape configuration

Set `METRICS_TOKEN` in the controller's environment and give the same value to
the monitoring team.

```yaml
scrape_configs:
  - job_name: backup-manager
    scrape_interval: 30s
    scheme: https
    authorization:
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ['backup-manager.internal']
```

With `METRICS_TOKEN` unset the endpoint answers any request and logs a warning
at boot. The exposition names every VM, backup host, schedule and pool in the
fleet, so set it before exposing the controller beyond the management network.

`up{job="backup-manager"} == 0` is worth an alert on its own: it is the only
signal that reports the controller itself being down, which no metric emitted
*by* the controller can ever tell you.

## Relaying through Telegraf

When Prometheus pulls from Telegraf rather than from the controller, Telegraf
scrapes `/metrics` and re-exposes it on a second port.

```bash
cd monitoring
sudo ./install-backup-metrics.sh --token <METRICS_TOKEN> --dry-run   # inspect
sudo ./install-backup-metrics.sh --token <METRICS_TOKEN>             # apply
```

[`install-backup-metrics.sh`](../monitoring/install-backup-metrics.sh) is
idempotent: it backs up the current config, removes any stray
`[[inputs.prometheus]]` from the *main* file (that block belongs in
`telegraf.d/` only), adds `namedrop = ["bm_*"]` to the existing `:9273` output,
installs [`telegraf-backup-manager.conf`](../monitoring/telegraf-backup-manager.conf)
at mode 0640 with the URL and token substituted, verifies with `telegraf --test`
**before** reloading, and confirms both ports afterwards.
[`telegraf.conf`](../monitoring/telegraf.conf) is a reference copy of the main
config for restoring it if it was overwritten.

The design survives the extra hop because every value here is a plain number —
nothing depends on a per-sample timestamp, which is what a relay mangles. Four
settings still matter:

| Setting | Value | Why |
|---|---|---|
| `metric_version` (input **and** output) | `1`, and the **same on both** | Telegraf round-trips the exposition unchanged only when input and output agree. Version 1 makes the metric name the Telegraf measurement name, which is what lets `namepass`/`namedrop` match `bm_*`; version 2 puts every series under one `prometheus` measurement, so those filters match nothing. |
| `bearer_token_string` | `METRICS_TOKEN` | Sends `Authorization: Bearer <token>`. |
| `expiration_interval` (output) | `5m` | The relay hides Prometheus's staleness handling; this is what eventually removes a decommissioned VM. Never `0s`. |
| `export_timestamp` (output) | `false` | Let Prometheus apply its own scrape time. `true` re-introduces the out-of-order problem this design avoids. |

Use a **second** `prometheus_client` output on its own port for these metrics
rather than mixing them into an output other dashboards already depend on.

Two costs, both cosmetic:

- **HELP text is lost.** Telegraf replaces every description with
  `Telegraf collected metric`. This document is the reference instead; `curl`
  the controller directly to read the real ones.
- **Telegraf adds its own tags** — `url` (what it scraped) and `host` (the
  Telegraf box). No metric here uses a label named `url`, which is why
  `bm_backup_host_info` carries `agent_url`. Remove `host` with
  `tagexclude = ["host"]` — **not** `tagdrop`, which discards whole metrics
  rather than tags.

Scraping the controller directly stays supported and is simpler: HELP text and
native staleness both survive. The relay is fine, it just needs the settings
above.

## How time is represented

Every point in time is a Unix-epoch **seconds gauge** named
`*_timestamp_seconds`, never a per-sample timestamp on the exposition line.

```promql
time() - bm_vm_backup_last_success_timestamp_seconds        # age in seconds
```

This is deliberate. Prometheus rejects samples whose explicit timestamp is far
in the past — which is exactly the state of a backup that last succeeded 30
hours ago — so stamping the line would make a series vanish at the moment it
became interesting. Explicit timestamps also disable staleness handling, so a
decommissioned VM would report its final value forever.

Cached values publish their own freshness next to them
(`*_updated_timestamp_seconds`), so a panel can tell "the disk is fine" apart
from "nobody has looked recently".

**Absent means absent.** A VM that has never completed a backup has *no*
`bm_vm_backup_last_success_timestamp_seconds` series rather than a zero. Alert
on `absent()` as well as on age, or a VM that has never once been backed up will
look healthier than one that is a day late.

## Per-VM metrics (VM dashboard)

Every VM the controller knows about is emitted, including VMs that have never
been backed up.

| Metric | Type | Meaning |
|---|---|---|
| `bm_vm_info{vm,vm_id,hypervisor,backup_host,schedule,schedule_type,method}` | gauge | Identity row, always 1. Join on the labels. |
| `bm_vm_protected{vm}` | gauge | 1 when an enabled schedule exists; 0 means nothing will back this VM up. |
| `bm_vm_backup_expected_interval_seconds{vm}` | gauge | Scheduled cadence. Use as the freshness threshold instead of a constant. |
| `bm_vm_backup_last_success_timestamp_seconds{vm}` | gauge | Last completed backup. |
| `bm_vm_backup_last_attempt_timestamp_seconds{vm}` | gauge | Last finished run of any outcome. |
| `bm_vm_backup_last_failure_timestamp_seconds{vm}` | gauge | Last failure. |
| `bm_vm_backup_age_seconds{vm}` | gauge | Seconds since last success, precomputed. |
| `bm_vm_backup_last_status{vm}` | gauge | 0 completed, 1 failed, 2 skipped, 3 rejected, 4 running, 5 queued, 6 cancelled, 7 retrying, -1 unknown. |
| `bm_vm_backup_last_start/end_timestamp_seconds{vm}` | gauge | Bounds of the most recent run. |
| `bm_vm_backup_last_duration_seconds{vm}` | gauge | Duration of the most recent finished run. |
| `bm_vm_backup_last_exit_code{vm}` | gauge | Agent exit code; 0 is success. |
| `bm_vm_backup_running` / `_queued{vm}` | gauge | What is happening right now. |
| `bm_vm_backup_progress_percent{vm}` | gauge | Progress of the in-flight run, 0–100. |
| `bm_vm_backup_last_progress_timestamp_seconds{vm}` | gauge | When the in-flight run last reported. |
| `bm_vm_backup_stuck{vm}` | gauge | 1 when a running job has reported nothing for an hour. |
| `bm_vm_backup_consecutive_failures{vm}` | gauge | Failures since the last success. |
| `bm_vm_backup_runs_24h{vm,result}` | gauge | Runs per outcome in 24h, from history — survives a controller restart. |

`bm_vm_backup_stuck` is defined by **silence, not runtime**: a 14-hour backup
that keeps reporting is healthy; a 90-minute one that has said nothing for an
hour is not.

`bm_vm_backup_consecutive_failures` only counts real outcomes — a skipped or
rejected run neither proves the VM is healthy nor broken, so it does not reset
a genuine failure streak.

## Per-VM offsite replication (rsync)

| Metric | Type | Meaning |
|---|---|---|
| `bm_vm_offsite_last_status{vm}` | gauge | 0 completed, 1 **partial**, 2 failed, 3 running, 4 retrying, 5 unknown. |
| `bm_vm_offsite_targets_total{vm}` | gauge | Destinations attempted on the last run. |
| `bm_vm_offsite_targets{vm,result}` | gauge | Destinations by outcome: success / failed / skipped. |
| `bm_vm_offsite_target_status{vm,offsite_host}` | gauge | Per-destination: 0 success, 1 skipped, 2 failed. |
| `bm_vm_offsite_last_success_timestamp_seconds{vm}` | gauge | Last time every destination received this VM. |
| `bm_vm_offsite_retry_timestamp_seconds{vm}` | gauge | When the controller will retry. |

**`partial` is its own state and is not success.** It means some destinations
hold this VM and some do not — the state most likely to be read as healthy right
up until a restore is needed. Any panel that counts only `failed` will miss it.

## Schedule configuration

`bm_schedule_enabled`, `bm_schedule_retention`, `bm_schedule_offsite_targets`,
`bm_schedule_warnings` — all labelled `{vm,schedule,schedule_type}`.

`bm_schedule_enabled == 0` deserves attention: a schedule disabled after
repeated failures is a common cause of backups that quietly stop.

## Backup hosts and hypervisors (infrastructure dashboard)

Deliberately narrow — reachability, when that was last confirmed, load, and
disks. A hypervisor's CPU and RAM belong to the virtualisation team's dashboard.

| Metric | Meaning |
|---|---|
| `bm_backup_host_up{backup_host}` | 1 when reachable. At 0, every VM behind it stops being backed up. |
| `bm_backup_host_last_health_check_timestamp_seconds{backup_host}` | If this stops advancing, the health checker has stalled and `_up` is no longer trustworthy. |
| `bm_backup_host_jobs_running` / `_queued{backup_host}` | Current load. |
| `bm_hypervisor_up{hypervisor}` | 1 when it answered its last connection test. |
| `bm_hypervisor_last_health_check_timestamp_seconds{hypervisor}` | When it was last tested. |
| `bm_hypervisor_vms_total` / `_vms_protected{hypervisor}` | The gap is unprotected capacity. |
| `bm_hypervisor_disk_{bytes_total,used_bytes,available_bytes,usage_ratio}{hypervisor,device,mountpoint}` | Disks via the agent's SSH probe. |
| `bm_hypervisor_metrics_updated_timestamp_seconds{hypervisor}` | Freshness of those disk figures. |

## Storage and offsite capacity

| Metric | Meaning |
|---|---|
| `bm_storage_pool_bytes_total` / `_used_bytes` / `_available_bytes` `{backup_host,pool,path}` | Backup storage. `_available_bytes` is what ends backups when it hits zero. |
| `bm_storage_pool_usage_ratio{...}` | 0–1. Format the panel as a percentage; alert on the ratio. |
| `bm_storage_pool_updated_timestamp_seconds{...}` | Stale figures mean the refresh loop or the host is down, not that usage stopped changing. |
| `bm_offsite_host_up{offsite_host}` | Destination reachability. |
| `bm_offsite_pool_*{offsite_host,pool,path}` | Same shape as the storage pool metrics. |

Sizes are **bytes**, converted from the whole-GiB figures the agents report.

## Fleet totals and platform health

`bm_vms_total`, `bm_vms_protected_total`, `bm_schedules_total`,
`bm_schedules_enabled_total`, `bm_backup_hosts_total`,
`bm_backup_hosts_online_total`, `bm_hypervisors_total`,
`bm_hypervisors_connected_total`, `bm_jobs_running_total`,
`bm_jobs_queued_total`, `bm_jobs_history_total`.

`bm_build_info`, `bm_controller_start_timestamp_seconds`,
`bm_scrape_timestamp_seconds`, `bm_scrape_duration_seconds`,
`bm_snapshot_age_seconds`.

Compare `bm_scrape_timestamp_seconds` with the Prometheus server clock to detect
drift between them — every freshness alert depends on those clocks agreeing.

## Certificates

`bm_certificate_expiry_timestamp_seconds{label,subject}` and
`bm_certificate_days_remaining{...}`, same shape as the blackbox exporter's
`ssl_cert_not_after`. Backups keep running past expiry; browser access does not.

## Counters

Cumulative since controller start, so use `rate()` / `increase()`:

- `bm_backup_runs_total{vm,backup_host,method,result}`
- `bm_backup_duration_seconds_sum` / `_count{vm,backup_host}` — divide for a mean
- `bm_backup_retries_total{vm}`
- `bm_offsite_sync_runs_total{vm,result}` — whole-run verdict: completed / partial / failed
- `bm_offsite_sync_results_total{vm,offsite_host,result}` — per-destination rsync outcomes
- `bm_restore_runs_total{vm,result}`

These **reset to zero when the controller restarts**, which Prometheus handles
natively; `bm_controller_start_timestamp_seconds` tells you when it happened.
They are incremented in-process as jobs finish rather than recomputed from job
history, because history is pruned and a counter that goes backwards breaks
every rate query built on it. For windows that must survive a restart, use
`bm_vm_backup_runs_24h` instead.

## Cardinality

Labels are bounded by fleet size: `vm`, `schedule`, `backup_host`,
`hypervisor`, `offsite_host`, `pool`, `device`, `mountpoint`, `method`,
`result`. Never a job id, an error string, or a timestamp. When adding a metric,
add it through `MetricWriter.emit()` in
`controller-backend/services/prometheusMetricsService.js` and keep that rule.

## Cost of a scrape

One cached snapshot of the JSON data files (10s TTL) is shared by every metric
in a response, and concurrent scrapes share a single in-flight read. No agent
calls, SSH, or `df` happen on the scrape path — disk figures come from records
maintained by the background refresh services, so `/metrics` stays fast and
still answers when a host is unreachable.

Watch `bm_scrape_duration_seconds` against `bm_jobs_history_total`. If scrape
time climbs as history grows, the fix is an in-memory job index updated on
write, not a longer cache.
