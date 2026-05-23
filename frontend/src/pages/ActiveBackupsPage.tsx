import ActiveBackups from '@/components/backups/ActiveBackups'

export default function ActiveBackupsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Active Jobs</h1>
        <p className="text-gray-600 mt-2">
          Monitor currently running and queued backup/restore jobs
        </p>
      </div>

      <ActiveBackups />
    </div>
  )
}
