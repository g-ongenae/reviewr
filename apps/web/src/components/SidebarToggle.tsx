interface Props {
  open: boolean;
  onToggle: () => void;
}

export const SidebarToggle = ({ open, onToggle }: Props) => {
  const label = open ? 'Hide sidebar' : 'Show sidebar';
  return (
    <button
      className="icon-button"
      onClick={onToggle}
      title={`${label} (Ctrl+B)`}
      aria-label={label}
      aria-expanded={open}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
      </svg>
    </button>
  );
};
