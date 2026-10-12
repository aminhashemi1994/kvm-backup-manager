# Inventory API

A read-only HTTP API over the controller's asset data, for consumers outside
the panel: a CMDB, an asset register, capacity reporting, or a one-off audit
export.

```
GET https://<controller>/api/inventory/...
```

Behind the panel's nginx the backend lives under the `/api-backup/` location,
which rewrites `^/api-backup/(.*)` to `/api/$1`. External consumers therefore
call:

```
GET https://<panel-host>/api-backup/inventory/...
```

Every route is a `GET` and touches no writer. It is mounted outside the panel's
session authentication for the same reason `/metrics` is — an integration
script cannot obtain or refresh a user JWT — and carries its own token instead.

## Authentication

Set `INVENTORY_API_TOKENS` in the controller's environment. It is a
comma-separated list, each entry `label:secret`:

```
INVENTORY_API_TOKENS=netops-hamid:9f3c…,cmdb-sync:41ab…
```

The label is **not** a secret. It exists so an access log can name which
consumer called, and so one client can be revoked by deleting its entry without
rotating everyone else's token. A bare `secret` with no label is accepted and
reported as `unnamed`.

Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Callers send it as a bearer token; `?token=` is also accepted so the endpoint
can be smoke-tested from a shell.

```bash
curl -H "Authorization: Bearer <secret>" https://<controller>/api/inventory/machines
```

Unlike `METRICS_TOKEN`, leaving `INVENTORY_API_TOKENS` unset **disables** the
API (`503`) rather than opening it. This surface enumerates every hostname, IP,
backup host, pool and schedule in the fleet, so "not configured yet" fails
closed. Wrong or missing tokens get `401`; token comparison is constant-time
and every candidate is checked even after a match, so neither the contents nor
the list position of a token leaks through response timing.

## Site / datacenter

The site (datacenter/zone) is recorded on the **backup host only**, as its
`site` field. Everything beneath a backup host inherits it:

```
backup host  (site: "DC-Tehran-1")
├── hypervisors        → inherit
│   └── virtual machines → inherit
└── offsite hosts      → inherit
```

Nothing routes or schedules on this value — it is descriptive. Keeping it in
one place means relocating a rack is a single edit rather than a sweep over
every hypervisor and VM.

Hosts created before this field existed have no site and report `site: null`
until someone fills one in. **`null` means "not recorded yet", never "no
datacenter"** — do not treat it as a distinct location when grouping.

Set it on a host with the existing endpoint (it accepts `site` on create and
update, and `""` clears it):

```bash
curl -X PUT -H "Authorization: Bearer <user-jwt>" -H 'Content-Type: application/json' \
  -d '{"site":"DC-Tehran-1"}' \
  https://<controller>/api/backup-hosts/<id>
```

## Endpoints

`GET /api/inventory` lists the endpoints below and is a cheap auth check.

### `GET /api/inventory/machines`

Every machine the panel knows about, in one flat list: backup hosts,
hypervisors, offsite hosts and VMs.

| Query | Meaning |
|---|---|
| `type=` | `backup-host`, `hypervisor`, `offsite-host`, `virtual-machine` (comma-separated) |
| `state=` | `Active`, `Down`, `Unknown` |
| `site=` | exact site name |
| `includeVms=false` | omit VMs — a topology view usually wants only the infrastructure |

Status is reported **twice** on purpose. `status` is the raw stored value,
whose vocabulary differs per machine kind (`online`, `connected`, `running`),
and `state` collapses it to `Active` / `Down` / `Unknown` for consumers that
just want the two-value answer. A machine that has never been health-checked
reports `Unknown` rather than being guessed into `Down`.

VMs always report `ip: null`: the panel tracks guests through libvirt on the
hypervisor and never learns a guest address. This is by design, not missing data.

### `GET /api/inventory/backup-hosts`

Backup hosts with hypervisor/VM/pool counts and a summed `capacity` rollup.

### `GET /api/inventory/storage-pools`

Pools grouped per backup host with per-pool disk usage and a per-host total.
`?backupHostId=` filters to one host; `?flat=true` returns one row per pool
instead of the grouped shape.

Pools whose `backupHostId` no longer resolves to a host are surfaced in a
trailing group with `backupHostId: null` rather than being silently dropped.

> **Disk usage percentages follow `df`:** they are computed against
> `used + available`, not against the raw total. Filesystem reserved blocks
> mean `used + available` is several percent short of `total`, so dividing by
> `total` understates usage — a host rollup would read 78% while its only pool
> reported 83%. Stored per-pool percentages (measured on the box by the agent)
> are preferred; the computed value is only a fallback.

### `GET /api/inventory/schedules`

Backup schedules with the resolved VM, hypervisor, backup host and storage
pool, plus `lastFiredAt` and a `lastRun` summary of the most recent job.
Filters: `enabled=true|false`, `vmId=`, `backupHostId=`.

### `GET /api/inventory/backup-history`

Backup job history, newest first — history is read from the recent end far more
often than paged from the beginning.

| Query | Meaning |
|---|---|
| `limit=` | default 100, max 1000 |
| `offset=` | page offset |
| `status=` | e.g. `completed,failed` |
| `vmId=` / `scheduleId=` / `backupHostId=` | filter |
| `since=` / `until=` | ISO timestamps, filter on `startTime` |

The response carries `total`, `limit`, `offset` and `hasMore` alongside `data`.
Each row includes a precomputed `durationSeconds` (`null` while a job is still
running) so consumers charting run length do not re-derive it and get the
in-flight case wrong.

## Response shape

All endpoints return the panel's usual envelope, plus a `generatedAt` stamp:

```json
{
  "success": true,
  "count": 116,
  "generatedAt": "2026-09-09T08:45:00.000Z",
  "data": [ ... ]
}
```
