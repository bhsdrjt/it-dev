import { useEffect, useId, useRef, useState } from 'react';

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  describedBy?: string;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
};
// Combobox sederhana: daftar pilihan di dalam panel, tanpa gaya hitam bawaan browser.
export function Combobox({ id, value, onChange, options, placeholder, describedBy, disabled, required, maxLength }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const query = value.trim().toLowerCase();
  const matches = options.filter(option => !query || option.toLowerCase().includes(query));
  const shown = matches.slice(0, 8);
  const choose = (option: string) => { onChange(option); setOpen(false); setActive(-1); input.current?.focus(); };
  return <div className="combobox" ref={container}>
    <input id={id} ref={input} role="combobox" aria-expanded={open && shown.length > 0} aria-controls={listId} aria-autocomplete="list" aria-describedby={describedBy} autoComplete="off" value={value} disabled={disabled} required={required} maxLength={maxLength} placeholder={placeholder}
      onFocus={() => setOpen(true)} onChange={event => { onChange(event.target.value); setOpen(true); setActive(-1); }} onBlur={event => { if (!container.current?.contains(event.relatedTarget as Node)) { setOpen(false); setActive(-1); } }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); return; }
        if (!open || !shown.length) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((active + 1) % shown.length); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((active - 1 + shown.length) % shown.length); }
        else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(shown[active]); }
      }} />
    <div id={listId} role="listbox" aria-label="Pilihan truck" className="combobox-options" hidden={!open || !shown.length}>
      {shown.map(option => <div key={option} role="option" aria-selected={option === shown[active]} className={option === shown[active] ? 'option active' : 'option'}
        onPointerDown={event => { event.preventDefault(); choose(option); }}>{option}</div>)}
      {matches.length > shown.length && <span className="combobox-more">{matches.length - shown.length} lainnya…</span>}
    </div>
  </div>;
}
