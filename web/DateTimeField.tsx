import { useEffect, useId, useRef, useState } from 'react';

// Nilai selalu ISO tanpa zona: YYYY-MM-DDTHH:mm:ss. Tampilan dd/mm/yyyy dan jam 24 jam,
// karena input bawaan browser mengikuti locale (bisa mm/dd/yyyy dan AM/PM).
const pad = (value: number) => String(value).padStart(2, '0');
const parts = (iso: string) => {
  const [date = '', clock = ''] = iso.split('T');
  const [year = '', month = '', day = ''] = date.split('-');
  const [hour = '00', minute = '00'] = clock.split(':');
  return { year: Number(year), month: Number(month), day: Number(day), hour, minute };
};
const isoOf = (year: number, month: number, day: number, hour: string, minute: string) => `${year}-${pad(month)}-${pad(day)}T${hour}:${minute}:00`;
const dayCount = (year: number, month: number) => new Date(year, month, 0).getDate();
// Senin sebagai kolom pertama.
const firstWeekday = (year: number, month: number) => (new Date(year, month - 1, 1).getDay() + 6) % 7;
const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const hours = Array.from({ length: 24 }, (_, i) => pad(i));
const minutes = Array.from({ length: 60 }, (_, i) => pad(i));

export function DateField({ id, label, value, onChange, disabled, describedBy }: {
  id: string;
  label: string;
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const { year, month, day, hour, minute } = parts(value);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ year, month });
  const root = useRef<HTMLDivElement>(null);
  const popupId = useId();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) setView({ year, month }); }, [open, year, month]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const pick = (nextDay: number) => { onChange(isoOf(view.year, view.month, nextDay, hour, minute)); setOpen(false); };
  const move = (step: number) => setView(current => {
    const at = new Date(current.year, current.month - 1 + step, 1);
    return { year: at.getFullYear(), month: at.getMonth() + 1 };
  });
  const cells = firstWeekday(view.year, view.month);
  return <div className="date-field" ref={root}>
    <label htmlFor={id}>{label}</label>
    <div className="date-field-row">
      <input id={id} type="text" readOnly value={`${pad(day)}/${pad(month)}/${year}`} aria-describedby={describedBy} disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open); } }} />
      <button type="button" className="transaction-icon-button" aria-label={`Pilih ${label.toLowerCase()}`} aria-expanded={open} aria-controls={popupId} disabled={disabled} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16v14H4zM4 10h16M9 3v4M15 3v4" /></svg>
      </button>
    </div>
    {open && <div className="date-popup" id={popupId} role="dialog" aria-label={`Kalender ${label.toLowerCase()}`}>
      <div className="date-popup-head">
        <button type="button" aria-label="Bulan sebelumnya" onClick={() => move(-1)}>‹</button>
        <strong>{monthNames[view.month - 1]} {view.year}</strong>
        <button type="button" aria-label="Bulan berikutnya" onClick={() => move(1)}>›</button>
      </div>
      <div className="date-popup-grid" role="grid">
        {['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map(name => <span key={name} className="date-popup-dow" aria-hidden="true">{name}</span>)}
        {Array.from({ length: cells }, (_, i) => <span key={`blank-${i}`} />)}
        {Array.from({ length: dayCount(view.year, view.month) }, (_, i) => {
          const at = i + 1;
          const current = at === day && view.month === month && view.year === year;
          return <button type="button" key={at} aria-pressed={current} className={current ? 'active' : ''} onClick={() => pick(at)}>{at}</button>;
        })}
      </div>
    </div>}
  </div>;
}

export function TimeField({ id, label, value, onChange, disabled, describedBy }: {
  id: string;
  label: string;
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const { year, month, day, hour, minute } = parts(value);
  const set = (nextHour: string, nextMinute: string) => onChange(isoOf(year, month, day, nextHour, nextMinute));
  return <div className="date-field">
    <label htmlFor={id}>{label}</label>
    <div className="time-field-row" id={id} role="group" aria-label={label} aria-describedby={describedBy}>
      <select aria-label={`Jam ${label.toLowerCase()}`} value={hour} disabled={disabled} onChange={event => set(event.target.value, minute)}>
        {hours.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <span aria-hidden="true">:</span>
      <select aria-label={`Menit ${label.toLowerCase()}`} value={minute} disabled={disabled} onChange={event => set(hour, event.target.value)}>
        {minutes.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>
  </div>;
}
