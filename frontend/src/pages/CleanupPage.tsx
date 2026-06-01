import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, Trash2, RefreshCw, AlertTriangle, CheckCircle2, FileText, Lock, Database } from 'lucide-react'
import { useCleanupScan, useExecuteCleanup, useCleanupControllerJobs, type AgentCleanupData, type CleanupFile } from '@/hooks/useCleanup'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { useConfirm } from '@/components/ui/confirm-dialog'

export default function CleanupPage() {
  const [olderThanHours, setOlderThanHours] = useState(6)
  const [selectedFiles, setSelectedFiles] = useState<Map<string, Set<string>>>(new Map())
  const [hostFilter, setHostFilter] = useState<string>('all')
  
  const { data: scanData, isLoading: isScanning, refetch: scan } = useCleanupScan(olderThanHours)
  const executeCleanup = useExecuteCleanup()
  const cleanupControllerJobs = useCleanupControllerJobs()
  const confirm = useConfirm()

  // Filter agents by selected host
  const filteredAgents = scanData?.agents?.filter(agent => 
    hostFilter === 'all' || agent.agentId === hostFilter
  ) || []

  const handleScan = () => {
    setSelectedFiles(new Map())
    scan()
  }

  const toggleFileSelection = (agentId: string, filePath: string) => {
    setSelectedFiles(prev => {
      const newMap = new Map(prev)
      const agentFiles = newMap.get(agentId) || new Set()
      
      if (agentFiles.has(filePath)) {
        agentFiles.delete(filePath)
      } else {
        agentFiles.add(filePath)
      }
      
      if (agentFiles.size === 0) {
        newMap.delete(agentId)
      } else {
        newMap.set(agentId, agentFiles)
      }
      
      return newMap
    })
  }

  const selectAllForAgent = (agentId: string, files: CleanupFile[]) => {
    setSelectedFiles(prev => {
      const newMap = new Map(prev)
      newMap.set(agentId, new Set(files.map(f => f.path)))
      return newMap
    })
  }

  const deselectAllForAgent = (agentId: string) => {
    setSelectedFiles(prev => {
      const newMap = new Map(prev)
      newMap.delete(agentId)
      return newMap
    })
  }

  const handleExecuteCleanup = async (agentId: string) => {
    const files = Array.from(selectedFiles.get(agentId) || [])
    if (files.length === 0) return
    
    await executeCleanup.mutateAsync({ agentId, files })
    setSelectedFiles(prev => {
      const newMap = new Map(prev)
      newMap.delete(agentId)
      return newMap
    })
    scan() // Refresh after cleanup
  }

  const handleCleanupControllerJobs = async () => {
    await cleanupControllerJobs.mutateAsync(olderThanHours)
    scan() // Refresh after cleanup
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const formatAge = (age: number) => {
    return formatDistanceToNow(Date.now() - age, { addSuffix: true })
  }

  const getFileIcon = (type: string) => {
    switch (type) {
      case 'progress': return <Database className="h-4 w-4 text-blue-600" />
      case 'log': return <FileText className="h-4 w-4 text-green-600" />
      case 'lock': return <Lock className="h-4 w-4 text-red-600" />
      case 'temp': return <FileText className="h-4 w-4 text-gray-600" />
      default: return <FileText className="h-4 w-4" />
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Cleanup Management</h1>
        <p className="text-gray-500 mt-2">
          Scan and clean up old backup/restore files across all agents
        </p>
      </div>

      {/* Scan Controls */}
      <Card>
        <CardHeader>
          <CardTitle>Scan for Cleanable Files</CardTitle>
          <CardDescription>
            Find old progress files, logs, lock files, and temporary files
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <label className="text-sm font-medium">Files older than:</label>
              <select
                value={olderThanHours}
                onChange={(e) => setOlderThanHours(parseInt(e.target.value))}
                className="border rounded px-3 py-2"
              >
                <option value={1}>1 hour</option>
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
                <option value={168}>7 days</option>
              </select>
            </div>
            
            <Button
              onClick={handleScan}
              disabled={isScanning}
            >
              {isScanning ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Scan Now
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Scan Results */}
      {scanData && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-gray-500">Total Files</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{scanData.totalFiles}</div>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-gray-500">Total Size</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatBytes(scanData.totalSize)}</div>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-gray-500">Agents Scanned</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{scanData.agents.length}</div>
              </CardContent>
            </Card>
          </div>

          {/* Errors */}
          {scanData.errors && scanData.errors.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-semibold mb-2">Failed to scan some agents:</div>
                <ul className="list-disc list-inside space-y-1">
                  {scanData.errors.map((error, idx) => (
                    <li key={idx}>
                      {error.agentName}: {error.error}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Controller Jobs */}
          {scanData.controllerJobs && scanData.controllerJobs.count > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Controller Restore Jobs</CardTitle>
                    <CardDescription>
                      Old completed/failed restore jobs in controller database
                    </CardDescription>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleCleanupControllerJobs}
                    disabled={cleanupControllerJobs.isPending}
                  >
                    {cleanupControllerJobs.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 mr-2" />
                    )}
                    Clean Up {scanData.controllerJobs.count} Jobs
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-sm text-gray-600">
                  These jobs are stored in the controller's database and can be safely removed.
                </div>
              </CardContent>
            </Card>
          )}

          {/* Agent Files */}
          {filteredAgents.length > 0 ? (
            <div className="space-y-4">
              {/* Global cleanup actions for ALL backup hosts */}
              {scanData.agents.length > 1 && (
                <Card className="border-2 border-blue-200 dark:border-blue-800/50 bg-blue-50/30 dark:bg-blue-900/10">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Trash2 className="h-5 w-5 text-blue-600" />
                      Global Cleanup — All Backup Hosts
                    </CardTitle>
                    <CardDescription>
                      Clean up files across multiple backup hosts in a single action.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                      <div className="p-3 rounded-lg bg-white dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50">
                        <div className="text-xs text-gray-500 mb-1">Total Files</div>
                        <div className="text-lg font-semibold">{scanData.totalFiles}</div>
                      </div>
                      <div className="p-3 rounded-lg bg-white dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50">
                        <div className="text-xs text-gray-500 mb-1">Total Size</div>
                        <div className="text-lg font-semibold">{formatBytes(scanData.totalSize)}</div>
                      </div>
                      <div className="p-3 rounded-lg bg-white dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50">
                        <div className="text-xs text-gray-500 mb-1">Across Hosts</div>
                        <div className="text-lg font-semibold">{scanData.agents.length}</div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Delete all files on all hosts?',
                            description: `Clean ALL ${scanData.totalFiles} files (${formatBytes(scanData.totalSize)}) across ${scanData.agents.length} backup host(s). This action is IRREVERSIBLE.`,
                            details: [
                              `${scanData.totalFiles} files will be permanently deleted`,
                              `Total size: ${formatBytes(scanData.totalSize)}`,
                              `Affected hosts: ${scanData.agents.length}`,
                            ],
                            requireInput: 'DELETE ALL',
                            confirmText: 'Delete all',
                            cancelText: 'Cancel',
                            variant: 'danger',
                          })
                          if (!ok) return
                          let total = 0
                          let failed = 0
                          for (const agent of scanData.agents) {
                            const allFiles = [
                              ...agent.progressFiles,
                              ...agent.logFiles,
                              ...agent.lockFiles,
                              ...agent.tempFiles,
                            ].map(f => f.path)
                            if (allFiles.length === 0) continue
                            try {
                              await executeCleanup.mutateAsync({ agentId: agent.agentId, files: allFiles })
                              total += allFiles.length
                            } catch (e) {
                              failed++
                              console.error(`Failed to clean ${agent.agentName}:`, e)
                            }
                          }
                          if (failed === 0) {
                            toast.success(`Cleaned ${total} file(s) across ${scanData.agents.length} host(s)`)
                          } else {
                            toast.warning(`Cleaned ${total} file(s); ${failed} host(s) failed`)
                          }
                          setSelectedFiles(new Map())
                          scan()
                        }}
                        disabled={executeCleanup.isPending}
                      >
                        {executeCleanup.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 mr-2" />
                        )}
                        Delete ALL files on ALL hosts
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          // Select all files on all hosts
                          const newMap = new Map<string, Set<string>>()
                          for (const agent of scanData.agents) {
                            const allFiles = [
                              ...agent.progressFiles,
                              ...agent.logFiles,
                              ...agent.lockFiles,
                              ...agent.tempFiles,
                            ].map(f => f.path)
                            if (allFiles.length > 0) {
                              newMap.set(agent.agentId, new Set(allFiles))
                            }
                          }
                          setSelectedFiles(newMap)
                          toast.info(`Selected ${scanData.totalFiles} file(s) across ${scanData.agents.length} host(s)`)
                        }}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Select All on All Hosts
                      </Button>

                      {selectedFiles.size > 0 && (
                        <>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={async () => {
                              const totalSelected = Array.from(selectedFiles.values()).reduce((s, set) => s + set.size, 0)
                              const ok = await confirm({
                                title: 'Delete selected files?',
                                description: `Delete ${totalSelected} selected file(s) across ${selectedFiles.size} host(s). This cannot be undone.`,
                                confirmText: 'Delete',
                                cancelText: 'Cancel',
                                variant: 'danger',
                              })
                              if (!ok) return
                              let success = 0
                              let failed = 0
                              for (const [agentId, fileSet] of selectedFiles.entries()) {
                                try {
                                  await executeCleanup.mutateAsync({ agentId, files: Array.from(fileSet) })
                                  success += fileSet.size
                                } catch (e) {
                                  failed++
                                }
                              }
                              if (failed === 0) {
                                toast.success(`Cleaned ${success} file(s) across ${selectedFiles.size} host(s)`)
                              } else {
                                toast.warning(`Cleaned ${success} file(s); ${failed} host(s) failed`)
                              }
                              setSelectedFiles(new Map())
                              scan()
                            }}
                            disabled={executeCleanup.isPending}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete {Array.from(selectedFiles.values()).reduce((s, set) => s + set.size, 0)} selected
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedFiles(new Map())}
                          >
                            Clear selection
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Host Filter */}
              {scanData.agents.length > 1 && (
                <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
                  <label className="text-sm font-medium text-gray-600 dark:text-gray-400">Filter by host:</label>
                  <select
                    value={hostFilter}
                    onChange={(e) => setHostFilter(e.target.value)}
                    className="border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-800"
                  >
                    <option value="all">All Hosts ({scanData.agents.length})</option>
                    {scanData.agents.map(agent => (
                      <option key={agent.agentId} value={agent.agentId}>
                        {agent.agentName} ({agent.totalCount} files)
                      </option>
                    ))}
                  </select>
                  {hostFilter !== 'all' && (
                    <button
                      onClick={() => setHostFilter('all')}
                      className="text-xs text-primary hover:underline"
                    >
                      Show all
                    </button>
                  )}
                </div>
              )}

              {filteredAgents.map((agent) => (
                <AgentCleanupCard
                  key={agent.agentId}
                  agent={agent}
                  selectedFiles={selectedFiles.get(agent.agentId) || new Set()}
                  onToggleFile={(filePath) => toggleFileSelection(agent.agentId, filePath)}
                  onSelectAll={(files) => selectAllForAgent(agent.agentId, files)}
                  onDeselectAll={() => deselectAllForAgent(agent.agentId)}
                  onExecuteCleanup={() => handleExecuteCleanup(agent.agentId)}
                  isExecuting={executeCleanup.isPending}
                  formatBytes={formatBytes}
                  formatAge={formatAge}
                  getFileIcon={getFileIcon}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Files to Clean</h3>
                  <p className="text-gray-500">
                    All agents are clean. No old files found.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

// Agent Cleanup Card Component
function AgentCleanupCard({
  agent,
  selectedFiles,
  onToggleFile,
  onSelectAll,
  onDeselectAll,
  onExecuteCleanup,
  isExecuting,
  formatBytes,
  formatAge,
  getFileIcon,
}: {
  agent: AgentCleanupData
  selectedFiles: Set<string>
  onToggleFile: (filePath: string) => void
  onSelectAll: (files: CleanupFile[]) => void
  onDeselectAll: () => void
  onExecuteCleanup: () => void
  isExecuting: boolean
  formatBytes: (bytes: number) => string
  formatAge: (age: number) => string
  getFileIcon: (type: string) => JSX.Element
}) {
  const allFiles = [
    ...agent.progressFiles,
    ...agent.logFiles,
    ...agent.lockFiles,
    ...agent.tempFiles,
  ]

  const allSelected = allFiles.length > 0 && allFiles.every(f => selectedFiles.has(f.path))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{agent.agentName}</CardTitle>
            <CardDescription>
              {agent.totalCount} files ({formatBytes(agent.totalSize)})
            </CardDescription>
          </div>
          <div className="flex items-center space-x-2">
            {allFiles.length > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => allSelected ? onDeselectAll() : onSelectAll(allFiles)}
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onExecuteCleanup}
                  disabled={selectedFiles.size === 0 || isExecuting}
                >
                  {isExecuting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  Delete Selected ({selectedFiles.size})
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">All ({allFiles.length})</TabsTrigger>
            <TabsTrigger value="progress">Progress ({agent.progressFiles.length})</TabsTrigger>
            <TabsTrigger value="logs">Logs ({agent.logFiles.length})</TabsTrigger>
            <TabsTrigger value="locks">Locks ({agent.lockFiles.length})</TabsTrigger>
            <TabsTrigger value="temp">Temp ({agent.tempFiles.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            <FileTable
              files={allFiles}
              selectedFiles={selectedFiles}
              onToggleFile={onToggleFile}
              formatBytes={formatBytes}
              formatAge={formatAge}
              getFileIcon={getFileIcon}
            />
          </TabsContent>

          <TabsContent value="progress">
            <FileTable
              files={agent.progressFiles}
              selectedFiles={selectedFiles}
              onToggleFile={onToggleFile}
              formatBytes={formatBytes}
              formatAge={formatAge}
              getFileIcon={getFileIcon}
            />
          </TabsContent>

          <TabsContent value="logs">
            <FileTable
              files={agent.logFiles}
              selectedFiles={selectedFiles}
              onToggleFile={onToggleFile}
              formatBytes={formatBytes}
              formatAge={formatAge}
              getFileIcon={getFileIcon}
            />
          </TabsContent>

          <TabsContent value="locks">
            <FileTable
              files={agent.lockFiles}
              selectedFiles={selectedFiles}
              onToggleFile={onToggleFile}
              formatBytes={formatBytes}
              formatAge={formatAge}
              getFileIcon={getFileIcon}
            />
          </TabsContent>

          <TabsContent value="temp">
            <FileTable
              files={agent.tempFiles}
              selectedFiles={selectedFiles}
              onToggleFile={onToggleFile}
              formatBytes={formatBytes}
              formatAge={formatAge}
              getFileIcon={getFileIcon}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

// File Table Component
function FileTable({
  files,
  selectedFiles,
  onToggleFile,
  formatBytes,
  formatAge,
  getFileIcon,
}: {
  files: CleanupFile[]
  selectedFiles: Set<string>
  onToggleFile: (filePath: string) => void
  formatBytes: (bytes: number) => string
  formatAge: (age: number) => string
  getFileIcon: (type: string) => JSX.Element
}) {
  if (files.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No files found
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12"></TableHead>
          <TableHead>Type</TableHead>
          <TableHead>File Name</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>Age</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow key={file.path}>
            <TableCell>
              <input
                type="checkbox"
                checked={selectedFiles.has(file.path)}
                onChange={() => onToggleFile(file.path)}
                className="h-4 w-4"
              />
            </TableCell>
            <TableCell>
              <div className="flex items-center space-x-2">
                {getFileIcon(file.type)}
                <Badge variant="outline" className="capitalize">
                  {file.type}
                </Badge>
              </div>
            </TableCell>
            <TableCell className="font-mono text-sm">{file.name}</TableCell>
            <TableCell>{formatBytes(file.size)}</TableCell>
            <TableCell className="text-gray-500">{formatAge(file.age)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
