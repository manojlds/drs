import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeProviderValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const THEME_KEY = 'drs-desktop:theme';
const ThemeProviderContext = createContext<ThemeProviderValue | null>(null);

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? systemTheme() : theme,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const next = theme === 'system' ? systemTheme() : theme;
      setResolvedTheme(next);
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.dataset.theme = theme;
    };

    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [theme]);

  const value = useMemo<ThemeProviderValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (next) => {
        localStorage.setItem(THEME_KEY, next);
        setThemeState(next);
      },
    }),
    [resolvedTheme, theme],
  );

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
