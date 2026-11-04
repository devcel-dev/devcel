/** Shared coordinates preserve the original thin ring and cross proportions. */
export function GridInsertIcon() {
  return (
    <svg className="rdg-insert-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="11.25" strokeWidth="1.5" />
      <path d="M7 12h10M12 7v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}