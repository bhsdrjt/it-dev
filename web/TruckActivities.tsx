import { Details } from './TransactionCard';
import { activityStage, isNewAssignment, sameCdn, type groupTruckActivities, type Row } from './transaction-analysis';

const labels = ['Kirim kosong', 'MT', 'Kirim muat', 'Tollgate', 'Terima muat', 'Terima kosong', 'Aktivitas lain', 'New Assignment'];
const icons = ['M12 20V4m-6 6 6-6 6 6', 'M12 20V8m-5 5a7 7 0 0 1 0-10m10 0a7 7 0 0 1 0 10', 'M4 20V8h16v12ZM8 8V4h8v4', 'M4 20V4h16v16M4 8h16M8 8v12', 'M12 4v16m-6-6 6 6 6-6', 'm4 12 5 5L20 6', 'M12 5v8m0 4v1', 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4'];
const text = (value: unknown) => value == null || value === '' ? '—' : String(value);
const time = (value: unknown) => text(value).replace('T', ' ').replace(/Z$/, '');
export function TruckActivities({ groups, offset, searchedCdn, beforeCdn, inTrip }: {
  groups: ReturnType<typeof groupTruckActivities>;
  offset: number;
  searchedCdn?: string;
  beforeCdn?: Set<Row>;
  inTrip?: Set<Row>;
}) {
  // Tanpa searchedCdn, tab ini dipakai Timeline truck dan tidak menampilkan status SK pencarian.
  const cdnStatus = (row: Row) => !searchedCdn ? null
    : sameCdn(row, searchedCdn) ? { label: 'SK dicari', tone: 'online' }
      : beforeCdn?.has(row) ? { label: 'Ritase SK ini · sebelum SK terbit', tone: 'online' }
        : inTrip?.has(row) ? { label: 'Ritase SK ini · hingga Terima Kosong', tone: 'online' }
          : { label: row.CoalDeliveryNumber ? 'SK lain' : 'SK tidak tercatat', tone: 'unknown' };
  return <div className="truck-trips" tabIndex={0} role="region" aria-label="Ritase aktivitas truck">
    <p className="helper">Urutan ideal: Kirim kosong · MT (opsional) · Kirim muat · Tollgate · Terima muat · Terima kosong. Kelengkapan hanya berdasarkan hasil dalam rentang pencarian. New Assignment mencatat perubahan assignment truck, bukan tahap timbang atau batas ritase; SK tidak ditentukan oleh catatan ini.</p>
    {groups.map((group, index) => <section className="truck-trip" key={offset + index} aria-label={`${group.status === 'Perubahan assignment' ? 'Perubahan assignment' : 'Ritase'} ${offset + index + 1}`}>
      <header className="trip-heading">
        <div>{group.status === 'Perubahan assignment' ? <h3>Perubahan assignment · di luar ritase yang terlihat</h3> : <>
          <h3>Ritase {offset + index + 1} · SK {group.sk.join(', ') || 'belum tercatat'}</h3>
          <p>Mulai {group.start === null ? 'tidak terlihat' : time(new Date(group.start).toISOString())} · Selesai {group.end === null ? 'tidak terlihat' : time(new Date(group.end).toISOString())} · Durasi {group.start === null || group.end === null ? '—' : `${Math.floor((group.end - group.start) / 60000)} menit`}</p>
        </>}</div><span className={`status ${group.status === 'Lengkap' ? 'online' : 'unknown'}`}>{group.status}</span>
      </header>
      {!!group.notes.length && <ul className="trip-notes">{group.notes.map(note => <li key={note}>{note}</li>)}</ul>}
      <ol className="transaction-timeline" aria-label="Urutan aktivitas ritase">
        {group.rows.map((row, i) => {
          const assignment = isNewAssignment(row);
          const stage = assignment ? 7 : activityStage(row) ?? 6;
          const status = cdnStatus(row);
          const searched = !!searchedCdn && (sameCdn(row, searchedCdn) || !!beforeCdn?.has(row) || !!inTrip?.has(row));
          return <li key={i} className={`activity-stage-${stage} ${searched ? 'trip-highlight' : ''} ${row.dtDeletedAt != null ? 'deleted-record' : ''}`}>
            <span className="timeline-marker" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={icons[stage]} /></svg></span>
            <article className="activity-card">
              <div className="transaction-title"><h3>{labels[stage]} <small>· {assignment ? 'Perubahan assignment truck' : text(row.trans)}</small></h3>
                {status && <div className="transaction-badges"><span className={`status ${status.tone}`}>{status.label}</span></div>}
              </div>
              {assignment ? <div className="transaction-times">
                <span>Waktu perubahan · dtTimeCollected <time>{time(row.dtTimeCollected)}</time></span>
                <span>Truck <strong>{text(row.strTruckCN)}</strong></span>
                <span>Assignment Loading <strong>{text(row.LoadingLocationName)}</strong></span>
                <span>Assignment Dumping <strong>{text(row.DumpingLocationName)}</strong></span>
              </div> : <div className="transaction-times"><span>dtTimeCollected <time>{time(row.dtTimeCollected)}</time></span><span>NO SK <time>{text(row.CoalDeliveryNumber)}</time></span><span>Tonase <time>{text(row.flTonnage)}</time></span><span>Lokasi <time>{text(row.ReaderLocationName)}</time></span></div>}
              <Details row={row} />
              {row.dtDeletedAt != null && <span className="deleted-status">Sudah dihapus · {time(row.dtDeletedAt)}</span>}
            </article>
          </li>;
        })}
      </ol>
    </section>)}
  </div>;
}
