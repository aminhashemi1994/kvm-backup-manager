import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Server, Activity, HardDrive, Cloud, RefreshCw } from 'lucide-react'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { metricsApi, storagePoolsApi } from '@/services/api'
import MetricsCard from '@/components/metrics/MetricsCard'
import RemoteHostMetrics from '@/components/metrics/RemoteHostMetrics'
import { toast } from 'sonner'

export default function Resources() {
  const [selectedHostId, setSelectedHostId] = useState<string>('')
  const [hypervisorFilterHostId, setHypervisorFilterHostId] = useState<string>('')
  const [offsiteFilterHostId, setOffsiteFilterHostId] = useState<string>('')
  const [isCollecting, setIsCollecting] = useState(false)
  
  const queryClient = useQueryClient()
  const { data: hosts, isLoading: hostsLoading, refetch: refetchHosts } = useBackupHosts()

  // Fetch all storage pools
  const { data: allStoragePools } = useQuery({
    queryKey: ['storage-pools'],
    queryFn: async () => {
      const response = await storagePoolsApi.getAll()
      return response.data.data || []
    },
    refetchInterval: 10000, // Refresh every 10 seconds
    staleTime: 0, // Always consider data stale
    cacheTime: 0, // Don't cache data
  })

  // Fetch hypervisor metrics
  const { data: hypervisorMetrics, refetch: refetchHypervisorMetrics, isLoading: hypervisorMetricsLoading } = useQuery({
    queryKey: ['hypervisor-metrics'],
    queryFn: async () => {
      const response = await metricsApi.getAllHypervisorMetrics()
      return response.data
    },
    refetchInterval: 30000, // Refresh every 30 seconds (reduced from 60 seconds)
    staleTime: 0, // Always consider data stale
    cacheTime: 0, // Don't cache data
  })

  // Filter hypervisors by selected backup host
  const filteredHypervisorMetrics = hypervisorMetrics?.data?.filter((metrics: any) => {
    if (!hypervisorFilterHostId) return true // Show all if no filter
    console.log('[Resources] Filtering hypervisor:', metrics.name, 'backupHostId:', metrics.backupHostId, 'filter:', hypervisorFilterHostId, 'match:', metrics.backupHostId === hypervisorFilterHostId)
    return metrics.backupHostId === hypervisorFilterHostId
  })

  // Fetch offsite metrics
  const { data: offsiteMetrics, refetch: refetchOffsiteMetrics, isLoading: offsiteMetricsLoading } = useQuery({
    queryKey: ['offsite-metrics'],
    queryFn: async () => {
      const response = await metricsApi.getAllOffsiteMetrics()
      return response.data
    },
    refetchInterval: 30000, // Refresh every 30 seconds (reduced from 60 seconds)
    staleTime: 0, // Always consider data stale
    cacheTime: 0, // Don't cache data
  })

  // Filter offsite hosts by selected backup host
  const filteredOffsiteMetrics = offsiteMetrics?.data?.filter((metrics: any) => {
    if (!offsiteFilterHostId) return true // Show all if no filter
    console.log('[Resources] Filtering offsite:', metrics.name, 'backupHostId:', metrics.backupHostId, 'filter:', offsiteFilterHostId, 'match:', metrics.backupHostId === offsiteFilterHostId)
    return metrics.backupHostId === offsiteFilterHostId
  })

  // Handle retry with collection trigger
  const handleRetryCollection = async () => {
    setIsCollecting(true)
    try {
      // Trigger collection on backend
      await metricsApi.triggerCollection()
      toast.success('Collecting metrics from all hosts...')
      
      // Wait for collection to complete (give it more time)
      await new Promise(resolve => setTimeout(resolve, 5000))
      
      // Invalidate and refetch ALL metrics queries (including individual backup host metrics)
      await queryClient.invalidateQueries({ queryKey: ['metrics'] })
      await queryClient.invalidateQueries({ queryKey: ['hypervisor-metrics'] })
      await queryClient.invalidateQueries({ queryKey: ['offsite-metrics'] })
      await queryClient.invalidateQueries({ queryKey: ['storage-pools'] })
      await queryClient.invalidateQueries({ queryKey: ['restore-storage-pools'] })
      
      // Force refetch
      await Promise.all([
        refetchHypervisorMetrics(),
        refetchOffsiteMetrics()
      ])
      
      toast.success('Metrics refreshed successfully')
    } catch (error: any) {
      console.error('Failed to trigger collection:', error)
      toast.error(error.response?.data?.error || 'Failed to refresh metrics')
    } finally {
      setIsCollecting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Resource Monitor</h1>
          <p className="text-gray-600 mt-1">Real-time system metrics and disk usage</p>
        </div>
      </div>

      <Tabs defaultValue="backup-hosts" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="backup-hosts" className="flex items-center space-x-2">
            <Server className="h-4 w-4" />
            <span>Backup Hosts</span>
          </TabsTrigger>
          <TabsTrigger value="hypervisors" className="flex items-center space-x-2">
            <HardDrive className="h-4 w-4" />
            <span>Hypervisors</span>
          </TabsTrigger>
          <TabsTrigger value="offsite" className="flex items-center space-x-2">
            <Cloud className="h-4 w-4" />
            <span>Offsite Hosts</span>
          </TabsTrigger>
        </TabsList>

        {/* Backup Hosts Tab */}
        <TabsContent value="backup-hosts" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center space-x-2">
                  <Server className="h-5 w-5" />
                  <span>Select Backup Host</span>
                </CardTitle>
                <div className="flex items-center space-x-2">
                  <p className="text-sm text-gray-500 font-normal">
                    Auto-updates every 10 seconds
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryCollection}
                    disabled={hostsLoading || isCollecting}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${(hostsLoading || isCollecting) ? 'animate-spin' : ''}`} />
                    {isCollecting ? 'Collecting...' : 'Refresh Now'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Select 
                value={selectedHostId} 
                onChange={(e) => setSelectedHostId(e.target.value)}
                className="w-full max-w-md"
              >
                <option value="">Choose a backup host...</option>
                {hosts?.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name} ({host.url})
                  </option>
                ))}
              </Select>
            </CardContent>
          </Card>

          {selectedHostId && (
            <MetricsCard 
              backupHostId={selectedHostId} 
              backupHostName={hosts?.find(h => h.id === selectedHostId)?.name || 'Unknown'}
            />
          )}

          {!selectedHostId && !hostsLoading && (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <Activity className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">Select a backup host to view its resource metrics</p>
                  <p className="text-sm text-gray-500 mt-2">Real-time updates every 10 seconds</p>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Hypervisors Tab */}
        <TabsContent value="hypervisors" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center space-x-2">
                  <HardDrive className="h-5 w-5" />
                  <span>Hypervisor Disk Usage</span>
                </CardTitle>
                <div className="flex items-center space-x-2">
                  <p className="text-sm text-gray-500 font-normal">
                    Auto-updates every 2 minutes
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryCollection}
                    disabled={hypervisorMetricsLoading || isCollecting}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${(hypervisorMetricsLoading || isCollecting) ? 'animate-spin' : ''}`} />
                    {isCollecting ? 'Collecting...' : 'Refresh Now'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-2">
                <span className="text-sm text-gray-600">Filter by Backup Host:</span>
                <Select 
                  value={hypervisorFilterHostId} 
                  onChange={(e) => setHypervisorFilterHostId(e.target.value)}
                  className="w-full max-w-md"
                >
                  <option value="">All Backup Hosts</option>
                  {hosts?.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name}
                    </option>
                  ))}
                </Select>
              </div>
            </CardContent>
          </Card>

          {filteredHypervisorMetrics && filteredHypervisorMetrics.length > 0 ? (
            <div className="grid grid-cols-1 gap-4">
              {filteredHypervisorMetrics.map((metrics: any) => {
                // Get storage pools for this hypervisor's backup host
                const hostStoragePools = allStoragePools?.filter(
                  (pool: any) => pool.backupHostId === metrics.backupHostId
                ) || []
                
                return (
                  <RemoteHostMetrics 
                    key={metrics.id} 
                    metrics={metrics}
                    storagePools={hostStoragePools}
                  />
                )
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <HardDrive className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">
                    {hypervisorFilterHostId 
                      ? 'No hypervisors found for selected backup host' 
                      : 'No hypervisor metrics available'}
                  </p>
                  <p className="text-sm text-gray-500 mt-2">Metrics will be collected automatically every 2 minutes</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryCollection}
                    disabled={isCollecting}
                    className="mt-4"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${isCollecting ? 'animate-spin' : ''}`} />
                    Collect Now
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Offsite Hosts Tab */}
        <TabsContent value="offsite" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center space-x-2">
                  <Cloud className="h-5 w-5" />
                  <span>Offsite Host Disk Usage</span>
                </CardTitle>
                <div className="flex items-center space-x-2">
                  <p className="text-sm text-gray-500 font-normal">
                    Auto-updates every 2 minutes
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryCollection}
                    disabled={offsiteMetricsLoading || isCollecting}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${(offsiteMetricsLoading || isCollecting) ? 'animate-spin' : ''}`} />
                    {isCollecting ? 'Collecting...' : 'Refresh Now'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-2">
                <span className="text-sm text-gray-600">Filter by Backup Host:</span>
                <Select 
                  value={offsiteFilterHostId} 
                  onChange={(e) => setOffsiteFilterHostId(e.target.value)}
                  className="w-full max-w-md"
                >
                  <option value="">All Backup Hosts</option>
                  {hosts?.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name}
                    </option>
                  ))}
                </Select>
              </div>
            </CardContent>
          </Card>

          {filteredOffsiteMetrics && filteredOffsiteMetrics.length > 0 ? (
            <div className="grid grid-cols-1 gap-4">
              {filteredOffsiteMetrics.map((metrics: any) => {
                // Get storage pools for this offsite host's backup host
                const hostStoragePools = allStoragePools?.filter(
                  (pool: any) => pool.backupHostId === metrics.backupHostId
                ) || []
                
                return (
                  <RemoteHostMetrics 
                    key={metrics.id} 
                    metrics={metrics}
                    storagePools={hostStoragePools}
                  />
                )
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <Cloud className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">
                    {offsiteFilterHostId 
                      ? 'No offsite hosts found for selected backup host' 
                      : 'No offsite host metrics available'}
                  </p>
                  <p className="text-sm text-gray-500 mt-2">Metrics will be collected automatically every 2 minutes</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryCollection}
                    disabled={isCollecting}
                    className="mt-4"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${isCollecting ? 'animate-spin' : ''}`} />
                    Collect Now
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
