import BackupHistory from '@/components/backups/BackupHistory'

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Job History</h1>
        <p className="text-gray-600 mt-2">
          View and analyze past backup and restore jobs
        </p>
      </div>

      <BackupHistory />
    </div>
  )
}
