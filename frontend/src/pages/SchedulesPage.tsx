import ScheduleList from '@/components/schedules/ScheduleList'

export default function SchedulesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Backup Schedules</h1>
        <p className="text-gray-600 mt-2">
          Configure automated backup schedules for your virtual machines
        </p>
      </div>

      <ScheduleList />
    </div>
  )
}
