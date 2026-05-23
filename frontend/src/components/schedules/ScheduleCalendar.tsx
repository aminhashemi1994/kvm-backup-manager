import { useState } from 'react'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function ScheduleCalendar() {
  const [selectedDates, setSelectedDates] = useState<Date[]>([])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Preview Schedule</CardTitle>
      </CardHeader>
      <CardContent>
        <Calendar
          mode="multiple"
          selected={selectedDates}
          onSelect={(dates: any) => setSelectedDates(dates || [])}
          className="rounded-md border"
        />
        <p className="text-xs text-gray-500 mt-2">
          Selected dates will run the backup according to the schedule
        </p>
      </CardContent>
    </Card>
  )
}
