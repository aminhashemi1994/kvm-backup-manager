import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Database, Mail, Linkedin, Github, ExternalLink, Bug, MessageSquare, GitPullRequest, Heart } from 'lucide-react'
import { useVersion } from '@/hooks/useVersion'

/**
 * AboutPage
 *
 * The one place in the panel that carries the author's details and the
 * project credits. The sidebar / login / settings footers used to repeat a
 * "Built by …" line each; they now point here instead.
 */

const AUTHOR = {
  name: 'Mohammad Amin Hashemi',
  role: 'Project creator and lead developer',
  email: 'aminhashemiwin10@gmail.com',
  linkedin: 'https://www.linkedin.com/in/amin-hashemi-2955061bb',
  github: 'https://github.com/aminhashemi1994',
  githubHandle: '@aminhashemi1994',
}

const REPO = 'https://github.com/aminhashemi1994/kvm-backup-manager'

const CREDITS = [
  {
    name: 'virtnbdbackup',
    by: '@abbbi',
    url: 'https://github.com/abbbi/virtnbdbackup',
    description:
      'The backup engine. Full and incremental backups of libvirt domains using changed block tracking and the NBD protocol.',
    license: 'GPL-3.0',
  },
  { name: 'libvirt', url: 'https://libvirt.org/', description: 'Virtualization API and management toolkit.' },
  { name: 'QEMU/KVM', url: 'https://www.qemu.org/', description: 'Machine emulator and virtualizer.' },
  { name: 'libnbd', url: 'https://gitlab.com/nbdkit/libnbd', description: 'NBD client library.' },
]

function ExternalRow({ href, icon: Icon, label, value }: { href: string; icon: any; label: string; value: string }) {
  const external = href.startsWith('http')
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors group"
    >
      <Icon className="h-4 w-4 text-gray-400 group-hover:text-primary flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-sm font-medium truncate">{value}</div>
      </div>
      {external && <ExternalLink className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500 flex-shrink-0" />}
    </a>
  )
}

export default function AboutPage() {
  const { data: version } = useVersion()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">About</h1>
        <p className="text-gray-500 mt-2">
          Who built this, what it is built on, and where to get help.
        </p>
      </div>

      {/* Product */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="w-14 h-14 rounded-2xl gradient-accent flex items-center justify-center shadow-lg shadow-blue-500/20 flex-shrink-0">
              <Database className="h-7 w-7 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-bold">{version?.name || 'KVM Backup Manager'}</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Backup and restore for KVM/QEMU virtual machines with incremental backups, centralized
                management, offsite replication, and real-time monitoring.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
              <Badge variant="outline" className="font-mono">{version ? `v${version.version}` : 'v…'}</Badge>
              <Badge variant="outline">{version?.license || 'MIT'} • Open Source</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Author */}
        <Card>
          <CardHeader>
            <CardTitle>Author</CardTitle>
            <CardDescription>{AUTHOR.role}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-lg font-semibold">{AUTHOR.name}</p>
              <p className="text-sm text-gray-500 mt-1">
                Passionate about virtualization, backup solutions, and open-source software. Reach out
                with questions, suggestions, deployment help, or to collaborate on improving this project.
              </p>
            </div>
            <div className="grid gap-2">
              <ExternalRow href={`mailto:${AUTHOR.email}`} icon={Mail} label="Email" value={AUTHOR.email} />
              <ExternalRow href={AUTHOR.linkedin} icon={Linkedin} label="LinkedIn" value="amin-hashemi-2955061bb" />
              <ExternalRow href={AUTHOR.github} icon={Github} label="GitHub" value={AUTHOR.githubHandle} />
            </div>
            <p className="text-xs text-gray-400">Copyright © 2024–{new Date().getFullYear()} {AUTHOR.name}. Licensed under the MIT License.</p>
          </CardContent>
        </Card>

        {/* Project & support */}
        <Card>
          <CardHeader>
            <CardTitle>Project &amp; Support</CardTitle>
            <CardDescription>Source code, bug reports, and contributions</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <ExternalRow href={REPO} icon={Github} label="Repository" value="aminhashemi1994/kvm-backup-manager" />
            <ExternalRow href={`${REPO}/issues`} icon={Bug} label="Found a bug?" value="Open a GitHub issue" />
            <ExternalRow href={`${REPO}/discussions`} icon={MessageSquare} label="Questions?" value="Start a GitHub discussion" />
            <ExternalRow href={`${REPO}/blob/main/CONTRIBUTING.md`} icon={GitPullRequest} label="Want to contribute?" value="Read CONTRIBUTING.md" />
          </CardContent>
        </Card>
      </div>

      {/* Credits */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Heart className="h-4 w-4 text-red-500" />
            Built On
          </CardTitle>
          <CardDescription>
            This project would not exist without these open-source projects and their communities.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {CREDITS.map((c) => (
              <a
                key={c.name}
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors group"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold group-hover:text-primary">
                    {c.name}
                    {c.by && <span className="text-gray-400 font-normal"> by {c.by}</span>}
                  </span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    {c.license && <Badge variant="outline" className="text-[10px]">{c.license}</Badge>}
                    <ExternalLink className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1.5">{c.description}</p>
              </a>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-4">
            Thanks also to the KVM/QEMU and libvirt communities, and to everyone who has reported bugs or
            given feedback.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
