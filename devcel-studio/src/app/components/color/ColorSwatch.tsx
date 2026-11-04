import type { CSSProperties } from 'react';
const checker: CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage: 'conic-gradient(#cccccc 25%, transparent 0 50%, #cccccc 0 75%, transparent 0)',
  backgroundSize: '12px 12px',
};
export function ColorSwatch({ color, className = '', label }: { color: string | null; className?: string; label?: string }) {
  return <span role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    className={`relative inline-block shrink-0 overflow-hidden rounded border border-border ${className}`} style={checker}>
    {color && <span className="absolute inset-0" style={{ backgroundColor: color }} />}
  </span>;
}
