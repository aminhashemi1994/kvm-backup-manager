import { useState } from 'react'
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Server, RefreshCw, AlertCircle, CheckCircle, XCircle, FileText, HardDrive, Database, Clock, Loader2, Plus, AlertTriangle, Search, ChevronDown } from 'lucide-react'
import { reportsApi, storagePoolsApi } from '@/services/api'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import VMReportCard from '@/components/reports/VMReportCard'
import ReportDownloadMenu from '@/components/reports/ReportDownloadMenu'

export default function Reports() {
  const navigate = useNavigate()
  const [selectedHostId, setSelectedHostId] = useState<string>('')
  const [selectedPoolPath, setSelectedPoolPath] = useState<string>('all') // 'all' or specific pool path
  const [searchQuery, setSearchQuery] = useState<string>('') // Search query for VM names
  const [rateLimitInfo, setRateLimitInfo] = useState<{
    isLimited: boolean
    remainingSeconds: number
    nextAllowedAt: string | null
  } | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false) // Track button loading state
  
  const { data: hosts, isLoading: hostsLoading } = useBackupHosts()

  // Load storage pools for selected backup host
  const { data: storagePools, isLoading: poolsLoading } = useQuery({
    queryKey: ['storage-pools', selectedHostId],
    queryFn: async () => {
      if (!selectedHostId) return []
      const response = await storagePoolsApi.getByBackupHost(selectedHostId)
      return response.data.data || []
    },
    enabled: !!selectedHostId,
  })

  const { data: report, isLoading: reportLoading, refetch: refetchReport, error, isFetching } = useQuery({
    queryKey: ['backup-report', selectedHostId],
    queryFn: async () => {
      if (!selectedHostId) return null
      const response = await reportsApi.getReport(selectedHostId)
      return response.data
    },
    enabled: !!selectedHostId,
    refetchInterval: false,
    retry: (failureCount, error: any) => {
      // Don't retry if rate limited (429) or not found (404) or conflict (409)
      if (error?.response?.status === 429 || error?.response?.status === 404 || error?.response?.status === 409) {
        return false
      }
      return failureCount < 1
    },
    // Keep old data while fetching new data
    placeholderData: (previousData) => previousData,
  })

  // Query for report status to check if generation is in progress
  const { data: reportStatus, refetch: refetchStatus } = useQuery({
    queryKey: ['backup-report-status', selectedHostId],
    queryFn: async () => {
      if (!selectedHostId) return null
      const response = await reportsApi.getStatus(selectedHostId)
      return response.data.data
    },
    enabled: !!selectedHostId,
    refetchInterval: false, // No need to poll since API waits for completion
  })

  // No need for polling effect since API waits for completion

  // Reset pool filter and search when host changes
  React.useEffect(() => {
    setSelectedPoolPath('all')
    setSearchQuery('')
  }, [selectedHostId])

  // Filter VMs by selected storage pool and search query
  const filteredVMs = React.useMemo(() => {
    if (!report?.data?.vms) return []
    
    let vms = report.data.vms
    
    // Filter by storage pool
    if (selectedPoolPath !== 'all') {
      vms = vms.filter((vm: any) => vm.storage_pool_path === selectedPoolPath)
    }
    
    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()
      vms = vms.filter((vm: any) => 
        vm.vm_name.toLowerCase().includes(query)
      )
    }
    
    return vms
  }, [report, selectedPoolPath, searchQuery])

  // Get unique storage pools from VMs
  const availableStoragePools = React.useMemo(() => {
    if (!report?.data?.vms) return []
    const pools = new Set<string>()
    report.data.vms.forEach((vm: any) => {
      if (vm.storage_pool_path) {
        pools.add(vm.storage_pool_path)
      }
    })
    return Array.from(pools).sort()
  }, [report])

  // Helper function for time ago
  const getTimeAgo = (dateString: string) => {
    const now = new Date().getTime()
    const then = new Date(dateString).getTime()
    const diffMs = now - then
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
  }

  const handleRefresh = async () => {
    if (!selectedHostId) return
    
    console.log('[Reports] Refresh clicked, selectedHostId:', selectedHostId)
    
    setIsRefreshing(true) // Start loading state
    setIsGenerating(true) // Mark as generating immediately
    
    try {
      const response = await reportsApi.generate(selectedHostId)
      console.log('[Reports] Generate response:', response)
      
      // Generation completed successfully
      toast.success('Report generated successfully!')
      setRateLimitInfo(null) // Clear any previous rate limit info
      
      // Refresh both the report data and status
      await Promise.all([
        refetchReport(),
        refetchStatus()
      ])
      
      console.log('[Reports] Report and status refreshed')
    } catch (error: any) {
      console.error('[Reports] Generate error:', error)
      console.error('[Reports] Error response:', error.response)
      
      if (error.response?.status === 409) {
        // Already generating
        toast.info('Report generation already in progress. Please wait...')
      } else if (error.response?.status === 429) {
        // Rate limited
        const data = error.response.data
        console.log('[Reports] Rate limited, data:', data)
        
        setRateLimitInfo({
          isLimited: true,
          remainingSeconds: data.remainingSeconds || 120,
          nextAllowedAt: data.nextAllowedAt
        })
        toast.error(`Rate limit: Please wait ${data.remainingSeconds || 120} seconds before requesting another report`)
        
        // Start countdown
        const interval = setInterval(() => {
          setRateLimitInfo(prev => {
            if (!prev || prev.remainingSeconds <= 1) {
              clearInterval(interval)
              return null
            }
            return {
              ...prev,
              remainingSeconds: prev.remainingSeconds - 1
            }
          })
        }, 1000)
      } else {
        const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message || 'Failed to generate report'
        const displayMessage = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage)
        toast.error(displayMessage)
      }
    } finally {
      setIsRefreshing(false) // End loading state
      setIsGenerating(false) // End generating state
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Backup Reports</h1>
          <p className="text-gray-600 mt-1">Comprehensive backup analysis and health status</p>
        </div>
        <ReportDownloadMenu
          scope="global"
          label="Download All Hosts"
          variant="default"
          size="default"
        />
      </div>

      {/* Host Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Server className="h-5 w-5" />
            <span>Select Backup Host</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center space-x-4">
              <div className="relative w-full max-w-md">
                <select
                  value={selectedHostId}
                  onChange={(e) => setSelectedHostId(e.target.value)}
                  className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 appearance-none"
                >
                  <option value="">Choose a backup host...</option>
                  {hosts?.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name} ({host.url})
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-3 h-4 w-4 opacity-50 pointer-events-none" />
              </div>

              {selectedHostId && (
                <>
                  <Button
                    variant="outline"
                    onClick={handleRefresh}
                    disabled={isFetching || isGenerating || isRefreshing || (rateLimitInfo?.isLimited ?? false)}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${(isFetching || isGenerating || isRefreshing) ? 'animate-spin' : ''}`} />
                    {isRefreshing || isGenerating
                      ? 'Generating...'
                      : isFetching
                        ? 'Loading...'
                        : rateLimitInfo?.isLimited 
                          ? `Wait ${rateLimitInfo.remainingSeconds}s` 
                          : 'Refresh Report'}
                  </Button>
                  <ReportDownloadMenu
                    scope="host"
                    scopeId={selectedHostId}
                    label="Download Host Report"
                  />
                </>
              )}
            </div>

            {/* Storage Pool Filter and Search */}
            {selectedHostId && report && availableStoragePools.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center space-x-4">
                  <label className="text-sm font-medium text-gray-700 whitespace-nowrap">
                    Filter by Storage Pool:
                  </label>
                  <div className="relative w-full max-w-md">
                    <select
                      value={selectedPoolPath}
                      onChange={(e) => setSelectedPoolPath(e.target.value)}
                      className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 appearance-none"
                    >
                      <option value="all">All Storage Pools ({report.data.vms.length} VMs)</option>
                      {availableStoragePools.map((poolPath) => {
                        const vmCount = report.data.vms.filter((vm: any) => vm.storage_pool_path === poolPath).length
                        return (
                          <option key={poolPath} value={poolPath}>
                            {poolPath} ({vmCount} VMs)
                          </option>
                        )
                      })}
                    </select>
                    <ChevronDown className="absolute right-3 top-3 h-4 w-4 opacity-50 pointer-events-none" />
                  </div>
                </div>

                {/* Search Bar */}
                <div className="flex items-center space-x-4">
                  <label className="text-sm font-medium text-gray-700 whitespace-nowrap">
                    Search VMs:
                  </label>
                  <div className="relative w-full max-w-md">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by VM name..."
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            
            {/* Storage Pool Warning */}
            {selectedHostId && !poolsLoading && (!storagePools || storagePools.length === 0) && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="space-y-3">
                  <p>
                    <strong>No storage pools defined for this backup host.</strong>
                  </p>
                  <p className="text-sm">
                    The report below shows data from the old system. To use the new storage pool system, 
                    you need to create at least one storage pool for this backup host.
                  </p>
                  <Button
                    size="sm"
                    onClick={() => navigate('/storage-pools')}
                    className="mt-2"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create Storage Pool
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            
            {rateLimitInfo?.isLimited && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-start space-x-2">
                <AlertCircle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-yellow-800">Rate Limit Active</p>
                  <p className="text-yellow-700">
                    Please wait {rateLimitInfo.remainingSeconds} seconds before requesting another report. 
                    This prevents server overload.
                  </p>
                </div>
              </div>
            )}

            {isGenerating && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-start space-x-2">
                <Loader2 className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5 animate-spin" />
                <div className="text-sm">
                  <p className="font-medium text-blue-800">Report Generation In Progress</p>
                  <p className="text-blue-700">
                    The backup report is currently being generated. This may take several minutes depending on the number of VMs and backup size.
                  </p>
                </div>
              </div>
            )}

            {reportStatus && !isGenerating && reportStatus.lastGenerated && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-start space-x-2">
                <Clock className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-green-800">Report Up to Date</p>
                  <p className="text-green-700">
                    Last generated: {new Date(reportStatus.lastGenerated).toLocaleString()}
                    {' '}({getTimeAgo(reportStatus.lastGenerated)})
                  </p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Report Content */}
      {selectedHostId && (
        <>
          {reportLoading && (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <RefreshCw className="h-12 w-12 animate-spin text-blue-600 mx-auto mb-4" />
                  <p className="text-gray-600">Loading backup report...</p>
                </div>
              </CardContent>
            </Card>
          )}

          {error && !report && (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  {(error as any).response?.status === 404 || (error as any).response?.data?.error?.includes('not yet generated') ? (
                    <>
                      <Clock className="h-12 w-12 text-orange-600 mx-auto mb-4" />
                      <p className="text-gray-900 font-medium mb-2">Report Not Yet Generated</p>
                      <p className="text-sm text-gray-600 mb-4">
                        No backup report has been generated for this host yet. Click the button below to generate the first report.
                      </p>
                      <Button
                        onClick={handleRefresh}
                        disabled={isFetching || isGenerating || isRefreshing || (rateLimitInfo?.isLimited ?? false)}
                        className="mt-2"
                      >
                        <RefreshCw className={`h-4 w-4 mr-2 ${(isFetching || isGenerating || isRefreshing) ? 'animate-spin' : ''}`} />
                        {isGenerating || isRefreshing ? 'Generating...' : 'Generate Report'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-12 w-12 text-red-600 mx-auto mb-4" />
                      <p className="text-gray-600 mb-2">Failed to load report</p>
                      <p className="text-sm text-gray-500">
                        {typeof (error as any).response?.data?.error === 'string' 
                          ? (error as any).response?.data?.error 
                          : (error as any).message || 'Unknown error'}
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => refetchReport()}
                        disabled={isFetching}
                        className="mt-4"
                      >
                        <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
                        Try Again
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {report && report.data && (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-600">Total VMs</p>
                        <p className="text-2xl font-bold">{filteredVMs.length}</p>
                        {selectedPoolPath !== 'all' && (
                          <p className="text-xs text-gray-500 mt-1">of {report.data.vm_count} total</p>
                        )}
                      </div>
                      <HardDrive className="h-8 w-8 text-blue-600" />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-600">Total Size</p>
                        <p className="text-2xl font-bold">
                          {selectedPoolPath === 'all' 
                            ? report.data.total_backup_size_gb
                            : (() => {
                                const totalBytes = filteredVMs.reduce((sum: number, vm: any) => sum + (vm.total_disk_usage_bytes || 0), 0)
                                return (totalBytes / (1024 * 1024 * 1024)).toFixed(3) + ' GB'
                              })()
                          }
                        </p>
                      </div>
                      <Database className="h-8 w-8 text-purple-600" />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-600">Healthy</p>
                        <p className="text-2xl font-bold text-green-600">
                          {selectedPoolPath === 'all'
                            ? report.data.summary.healthy
                            : filteredVMs.filter((vm: any) => vm.health === 'healthy').length
                          }
                        </p>
                      </div>
                      <CheckCircle className="h-8 w-8 text-green-600" />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-600">In Progress</p>
                        <p className="text-2xl font-bold text-blue-600">
                          {selectedPoolPath === 'all'
                            ? filteredVMs.filter((vm: any) => vm.health === 'in_progress').length
                            : filteredVMs.filter((vm: any) => vm.health === 'in_progress').length
                          }
                        </p>
                      </div>
                      <Loader2 className="h-8 w-8 text-blue-600" />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-600">Issues</p>
                        <p className="text-2xl font-bold text-red-600">
                          {selectedPoolPath === 'all'
                            ? report.data.summary.corrupted + report.data.summary.no_backups
                            : filteredVMs.filter((vm: any) => 
                                vm.health === 'all_corrupted' || 
                                vm.health === 'partially_corrupted' || 
                                vm.health === 'no_backups'
                              ).length
                          }
                        </p>
                      </div>
                      <XCircle className="h-8 w-8 text-red-600" />
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Report Metadata */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <FileText className="h-5 w-5" />
                    <span>Report Information</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-gray-600">Generated At</p>
                      <p className="font-medium">{new Date(report.data.generated_at).toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Hostname</p>
                      <p className="font-medium font-mono">{report.data.hostname}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Backup Path</p>
                      <p className="font-medium font-mono text-xs">{report.data.backup_path}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* VM List */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>
                      Virtual Machines ({filteredVMs.length}
                      {(selectedPoolPath !== 'all' || searchQuery) && ` of ${report.data.vms.length} total`})
                    </CardTitle>
                    {(selectedPoolPath !== 'all' || searchQuery) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedPoolPath('all')
                          setSearchQuery('')
                        }}
                      >
                        Clear Filters
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {filteredVMs.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      <HardDrive className="h-12 w-12 mx-auto mb-2 text-gray-400" />
                      <p>
                        {searchQuery 
                          ? `No VMs found matching "${searchQuery}"`
                          : selectedPoolPath !== 'all'
                            ? 'No VMs found in this storage pool'
                            : 'No VMs found'
                        }
                      </p>
                      {(selectedPoolPath !== 'all' || searchQuery) && (
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => {
                            setSelectedPoolPath('all')
                            setSearchQuery('')
                          }}
                          className="mt-2"
                        >
                          Clear filters to see all VMs
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {filteredVMs.map((vm: any) => (
                        <VMReportCard key={vm.vm_name} vm={vm} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}

      {!selectedHostId && !hostsLoading && (
        <Card>
          <CardContent className="py-12">
            <div className="text-center">
              <Server className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">Select a backup host to view its report</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
