import { FolderOpen, GitCompareArrows, KanbanSquare, Workflow, Settings2, X } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/renderer/components/ui/sidebar';

export type ProjectMode = 'review' | 'workflow' | 'factory' | 'settings';

interface AppSidebarProps {
  workingDir: string | null;
  recentProjects: string[];
  projectMode: ProjectMode;
  onModeChange: (mode: ProjectMode) => void;
  onOpenProject: () => void;
  onSelectProject: (dir: string) => void;
  onForgetProject: (dir: string) => void;
}

const MODE_ITEMS: Array<{ id: ProjectMode; label: string; icon: typeof GitCompareArrows }> = [
  { id: 'review', label: 'Review', icon: GitCompareArrows },
  { id: 'workflow', label: 'Workflows', icon: Workflow },
  { id: 'factory', label: 'Factory', icon: KanbanSquare },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

export function AppSidebar({
  workingDir,
  recentProjects,
  projectMode,
  onModeChange,
  onOpenProject,
  onSelectProject,
  onForgetProject,
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark">DRS</span>
          <span className="sidebar-brand-label">Review Cockpit</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {workingDir && (
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {MODE_ITEMS.map(({ id, label, icon: Icon }) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton
                      isActive={projectMode === id}
                      tooltip={label}
                      onClick={() => onModeChange(id)}
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Open a repository" onClick={onOpenProject}>
                  <FolderOpen />
                  <span>Open Project...</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Recent</SidebarGroupLabel>
          <SidebarGroupContent>
            {recentProjects.length === 0 ? (
              <div className="sidebar-empty-hint">No recent projects yet.</div>
            ) : (
              <SidebarMenu>
                {recentProjects.map((project) => (
                  <SidebarMenuItem key={project}>
                    <SidebarMenuButton
                      isActive={workingDir === project}
                      tooltip={project}
                      onClick={() => onSelectProject(project)}
                    >
                      <span>{projectDisplayName(project)}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      title="Remove from recent projects"
                      onClick={(event) => {
                        event.stopPropagation();
                        onForgetProject(project);
                      }}
                    >
                      <X />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function projectDisplayName(project: string): string {
  return project.split('/').filter(Boolean).pop() ?? project;
}
