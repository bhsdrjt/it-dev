import { useEffect, useState } from 'react';
import './theme.css';

export function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('theme');
      if (saved === 'dark' || saved === 'light') return saved === 'dark';
    } catch { /* Storage diblokir: gunakan preferensi OS. */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return <button type="button" className="theme-toggle" aria-label="Mode gelap" aria-pressed={dark} title={dark ? 'Ganti ke mode terang' : 'Ganti ke mode gelap'} onClick={() => {
    setDark(!dark);
    try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch { /* Tema tetap berlaku selama sesi ini. */ }
  }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dark ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z" />}
    </svg><span>{dark ? 'Light' : 'Dark'}</span>
  </button>;
}
