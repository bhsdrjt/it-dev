// Panel skeleton untuk menampilkan efek loading saat menunggu query selesai.
export function SkeletonPanel({ title, subtitle, rows = 4 }: {
  title: string;
  subtitle?: string;
  rows?: number;
}) {
  return <section className="panel anomaly-skeleton" aria-label={title} aria-busy="true">
    <div className="panel-heading">
      <div><span className="section-index" role="status">Memuat {title}…</span><h2>{title}</h2></div>
    </div>
    <div className="anomaly-skeleton-body" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => <div className="skeleton-row" key={i}>
        <div className="skeleton-block skeleton-wide"></div>
        <div className="skeleton-block skeleton-narrow"></div>
        {i % 2 === 0 && <div className="skeleton-block skeleton-narrow"></div>}
        {i % 3 === 0 && <div className="skeleton-block skeleton-narrow"></div>}
      </div>)}
    </div>
  </section>;
}
