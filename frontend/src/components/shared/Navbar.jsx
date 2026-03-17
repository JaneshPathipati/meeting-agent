// file: frontend/src/components/shared/Navbar.jsx
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { LogOut, Moon, Sun, Menu } from 'lucide-react';

function Navbar({ onToggleSidebar }) {
  const { profile, logout } = useAuth();
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('meetchamp-dark-mode');
    if (saved !== null) return saved === 'true';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  // Apply dark class on mount
  React.useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  function toggleDarkMode() {
    const next = !darkMode;
    setDarkMode(next);
    localStorage.setItem('meetchamp-dark-mode', String(next));
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-white px-4 dark:bg-gray-800 dark:border-gray-700">
      <button
        onClick={onToggleSidebar}
        className="lg:hidden p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="flex-1">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">MeetChamp</h1>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={toggleDarkMode}
          className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Toggle dark mode"
        >
          {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>

        <div className="hidden sm:flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <span>{profile?.full_name}</span>
        </div>

        <button
          onClick={logout}
          className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
          title="Sign out"
        >
          <LogOut className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}

export default Navbar;
