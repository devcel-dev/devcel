import React, { useId } from 'react';

export function AddRowIcon(props: React.SVGProps<SVGSVGElement>) {
  const maskId = useId();
  return (
    <svg {...props} width={20} height={20} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" stroke="none" />
          <circle cx="19" cy="19" r="6.5" fill="black" stroke="none" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <rect x="3" y="3" width="18" height="10" rx="1.5" />
        <path strokeWidth="1" d="M3 8h18M10 3v10" />
      </g>
      <path d="M13 21H4.5A1.5 1.5 0 0 1 3 19.5v-1A1.5 1.5 0 0 1 4.5 17H13M19 16v6M16 19h6" />
    </svg>
  );
}

export function AddColumnIcon(props: React.SVGProps<SVGSVGElement>) {
  const maskId = useId();
  return (
    <svg {...props} width={20} height={20} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <g transform="matrix(0 1 1 0 0 0)">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="white" stroke="none" />
            <circle cx="19" cy="19" r="6.5" fill="black" stroke="none" />
          </mask>
        </defs>
        <g mask={`url(#${maskId})`}>
          <rect x="3" y="3" width="18" height="10" rx="1.5" />
          <path strokeWidth="1" d="M3 8h18M10 3v10" />
        </g>
        <path d="M13 21H4.5A1.5 1.5 0 0 1 3 19.5v-1A1.5 1.5 0 0 1 4.5 17H13M19 16v6M16 19h6" />
      </g>
    </svg>
  );
}

export function TableSettingsIcon(props: React.SVGProps<SVGSVGElement>) {
  const maskId = useId();
  return (
    <svg {...props} width={20} height={20} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" stroke="none" />
          <circle cx="18" cy="18" r="8.25" fill="black" stroke="none" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <path d="M11 20H4.5A1.5 1.5 0 0 1 3 18.5v-14A1.5 1.5 0 0 1 4.5 3h14A1.5 1.5 0 0 1 20 4.5V10" />
        <path strokeWidth="1" d="M3 9h17M9 3v17" />
      </g>
      <polygon points="21.800,18.000 22.708,18.936 22.435,19.837 21.160,20.111 20.687,20.687 20.667,21.991 19.837,22.435 18.741,21.727 18.000,21.800 17.064,22.708 16.163,22.435 15.889,21.160 15.313,20.687 14.009,20.667 13.565,19.837 14.273,18.741 14.200,18.000 13.292,17.064 13.565,16.163 14.840,15.889 15.313,15.313 15.333,14.009 16.163,13.565 17.259,14.273 18.000,14.200 18.936,13.292 19.837,13.565 20.111,14.840 20.687,15.313 21.991,15.333 22.435,16.163 21.727,17.259" />
      <circle cx="18" cy="18" r="1.4" />
    </svg>
  );
}

