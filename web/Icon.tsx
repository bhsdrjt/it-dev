export type IconName = 'ping' | 'edit' | 'trash' | 'reload' | 'plus' | 'upload' | 'download' | 'search' | 'play' | 'clock' | 'calendar' | 'reset' | 'open' | 'close' | 'history';

const paths: Record<IconName, string> = {
  ping: 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.2 19.1 19.1M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  reload: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 21V9m-4 4 4-4 4 4M4 7V4h16v3',
  download: 'M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  play: 'M7 4l13 8-13 8Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  reset: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4',
  open: 'M7 17 17 7M8 7h9v9',
  close: 'M6 6l12 12M6 18 18 6',
  history: 'M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2',
};

/** Ikon dekoratif; nama aksi selalu dibawa lewat title + aria-label pada tombol induk. */
export function Icon({ name }: { name: IconName }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
