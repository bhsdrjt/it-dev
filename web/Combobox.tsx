import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

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
export function Combobox({ id, value, onChange, options, placeholder, describedBy, disabled, required, maxLength }: Props) {
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const query = browse || options.includes(value) ? '' : value.trim().toLowerCase();
  const shown = options.filter(option => !query || option.toLowerCase().includes(query));
  const expanded = open && !disabled && shown.length > 0;
  useLayoutEffect(() => {
    const popup = list.current;
    if (!popup || !expanded) { popup?.hidePopover(); return; }
    const position = () => {
      const rect = container.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upwards = below < 180 && above > below;
      const height = Math.max(0, Math.min(260, upwards ? above : below));
      Object.assign(popup.style, {
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`,
        width: `${Math.min(rect.width, window.innerWidth - 16)}px`,
        maxHeight: `${height}px`,
        top: upwards ? 'auto' : `${rect.bottom + 3}px`,
        bottom: upwards ? `${window.innerHeight - rect.top + 3}px` : 'auto',
      });
    };
    position();
    popup.showPopover();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      popup.hidePopover();
    };
  }, [expanded]);
  useEffect(() => {
    if (expanded && active >= 0) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, expanded]);
  const choose = (option: string) => { onChange(option); input.current?.focus(); setOpen(false); setBrowse(false); setActive(-1); };
  return <div className="combobox" ref={container} onBlur={event => { if (!container.current?.contains(event.relatedTarget as Node)) { setOpen(false); setActive(-1); } }}>
    <input id={id} ref={input} role="combobox" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && active >= 0 && shown[active] ? `${listId}-${active}` : undefined} aria-autocomplete="list" aria-describedby={describedBy} autoComplete="off" value={value} disabled={disabled} required={required} maxLength={maxLength} placeholder={placeholder}
      onFocus={() => setOpen(true)} onChange={event => { onChange(event.target.value); setBrowse(false); setOpen(true); setActive(-1); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          if (shown.length) setActive(event.key === 'ArrowDown' ? (active + 1) % shown.length : (active <= 0 ? shown.length : active) - 1);
        } else if (event.key === 'Enter' && expanded && active >= 0 && shown[active]) { event.preventDefault(); choose(shown[active]); }
      }} />
    <button type="button" className="combobox-toggle" aria-label="Tampilkan daftar truck" aria-expanded={expanded} aria-controls={listId} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { input.current?.focus(); setBrowse(true); setActive(-1); setOpen(!expanded); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div id={listId} ref={list} popover="manual" role="listbox" aria-label="Pilihan truck" className="combobox-options">
      {shown.map((option, index) => <div id={`${listId}-${index}`} key={option} role="option" aria-selected={index === active} className={index === active ? 'option active' : 'option'}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>{option}</div>)}
    </div>
  </div>;
}
