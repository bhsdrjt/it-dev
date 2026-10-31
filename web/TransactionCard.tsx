import type { Row } from './transaction-analysis';
export const value = (item: Row[string] | undefined) => item === null || item === undefined || item === '' ? '—' : String(item);
// SQL datetime tidak menyimpan zona waktu. Tampilkan jam database tanpa pergeseran browser.
export const date = (item: Row[string] | undefined) => typeof item === 'string' ? item.replace('T', ' ').replace(/Z$/, '') : value(item);
export const cell = (key: string, item: Row[string]) => key.startsWith('dt') ? date(item) : value(item);
export function ActionIcon({ action }: { action: 'receive' | 'unlink' | 'link' | 'inspect' | 'columns' }) {
  const paths = {
    inspect: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    receive: 'M12 3v12m-4-4 4 4 4-4M4 14v6h16v-6',
    unlink: 'm3 3 18 18M9 15l6-6M6 12l-2 2a4 4 0 0 0 6 6l2-2M12 6l2-2a4 4 0 0 1 6 6l-2 2',
    link: 'm9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    columns: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[action]} /></svg>;
}
export function Details({ row }: {
  row: Row
}) {
  return <details className="transaction-details column-details">
    <summary className="transaction-icon-button" aria-label="Detail seluruh kolom" title="Detail seluruh kolom">
      <ActionIcon action="columns" />
    </summary>
    <dl>
      {Object.entries(row).map(([key, item]) => <div key={key}>
        <dt>
          {key}
        </dt>
        <dd>
          {cell(key, item)}
        </dd>
      </div>)}
    </dl>
  </details>;
}
