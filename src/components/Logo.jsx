// Swachh Safar mark: a leaf (cleanliness) over a rail track (journey). Same artwork as public/logo.svg.
export default function Logo({ className = 'h-11 w-11' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Swachh Safar logo">
      <rect width="64" height="64" rx="16" fill="#0f766e" />
      <path d="M32 12c10 6 14 14 12 22-2 7-8 10-12 10s-10-3-12-10c-2-8 2-16 12-22Z" fill="#5eead4" />
      <path d="M32 18v24" stroke="#0f766e" strokeWidth="3" strokeLinecap="round" />
      <path d="M32 28l-6-5M32 34l6-5" stroke="#0f766e" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M14 50h36M14 55h36" stroke="#ccfbf1" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M20 47v11M32 47v11M44 47v11" stroke="#ccfbf1" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
