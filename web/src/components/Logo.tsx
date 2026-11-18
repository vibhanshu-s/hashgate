export function Logo({ size = 22 }: { size?: number }) {
  // A gate made of hash chains: two pillars of links and a lintel.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="20" height="4" rx="1.5" fill="var(--color-mint)" />
      <rect x="4" y="9" width="4" height="4" rx="1" stroke="var(--color-mint)" strokeWidth="1.6" />
      <rect x="4" y="15" width="4" height="4" rx="1" stroke="var(--color-mint)" strokeWidth="1.6" />
      <rect x="16" y="9" width="4" height="4" rx="1" stroke="var(--color-mint)" strokeWidth="1.6" />
      <rect x="16" y="15" width="4" height="4" rx="1" stroke="var(--color-mint)" strokeWidth="1.6" />
    </svg>
  );
}
