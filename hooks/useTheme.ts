import { useState, useEffect, useCallback } from 'react';

/**
 * Manages application theme (light/dark) and applies it to the document root.
 * Toggles the `light`/`dark` class on `<html>` for CSS variable switching.
 */
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme } as const;
}
