import BackupHistory from '@/components/backups/BackupHistory'

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Job History</h1>
        <p className="text-gray-600 mt-2">
          Backup, restore and rsync jobs — every backup that triggers a sync records that transfer
          as its own row here, so the offsite half is not a derived view of the backup.
        </p>
      </div>

      <BackupHistory />
    </div>
  )
}
