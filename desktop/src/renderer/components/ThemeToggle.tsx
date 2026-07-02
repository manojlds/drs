import { Laptop, Moon, Sun } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { useTheme } from './theme-provider';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
  const label = theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark theme' : 'Light theme';
  const Icon = theme === 'system' ? Laptop : theme === 'dark' ? Moon : Sun;

  return (
    <Button variant="outline" size="sm" onClick={() => setTheme(next)} title={`${label}. Click to switch.`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
