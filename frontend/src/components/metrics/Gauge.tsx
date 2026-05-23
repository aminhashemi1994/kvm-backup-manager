interface GaugeProps {
  value: number
  max?: number
  label: string
  unit?: string
  size?: number
  thresholds?: {
    warning: number
    danger: number
  }
}

export default function Gauge({ 
  value, 
  max = 100, 
  label, 
  unit = '%',
  size = 200,
  thresholds = { warning: 70, danger: 90 }
}: GaugeProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100))
  
  // Determine color based on thresholds
  const getColor = () => {
    if (percentage >= thresholds.danger) return '#ef4444' // red
    if (percentage >= thresholds.warning) return '#f59e0b' // orange
    return '#10b981' // green
  }

  const color = getColor()
  const radius = size / 2 - 20
  const circumference = Math.PI * radius

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.7} className="overflow-visible">
        {/* Background arc */}
        <path
          d={`M ${size / 2 - radius} ${size / 2} A ${radius} ${radius} 0 0 1 ${size / 2 + radius} ${size / 2}`}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="12"
          strokeLinecap="round"
        />
        
        {/* Value arc */}
        <path
          d={`M ${size / 2 - radius} ${size / 2} A ${radius} ${radius} 0 0 1 ${size / 2 + radius} ${size / 2}`}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percentage / 100)}
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
        
        {/* Center dot */}
        <circle cx={size / 2} cy={size / 2} r="8" fill={color} />
        
        {/* Value text */}
        <text
          x={size / 2}
          y={size / 2 + 30}
          textAnchor="middle"
          className="text-2xl font-bold"
          fill="currentColor"
        >
          {value.toFixed(1)}{unit}
        </text>
      </svg>
      
      <div className="text-center mt-2">
        <p className="text-sm font-medium text-gray-700">{label}</p>
      </div>
    </div>
  )
}
