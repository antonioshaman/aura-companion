export function Footer() {
  return (
    <footer className="relative z-10 border-t border-cc-border py-10 px-5 sm:px-7 text-center text-sm text-cc-muted">
      <p className="font-mono-code tracking-wide">Aura Companion — MIT</p>
      <div className="flex justify-center gap-6 mt-2">
        <a
          href="https://github.com/antonioshaman/aura-companion"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub repository, opens in a new tab"
          className="text-cc-muted hover:text-cc-fg transition-colors"
        >
          GitHub
        </a>
        <a
          href="https://github.com/antonioshaman/aura-companion/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="MIT License, opens in a new tab"
          className="text-cc-muted hover:text-cc-fg transition-colors"
        >
          MIT License
        </a>
        <a
          href="https://github.com/antonioshaman/aura-companion#attribution"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Upstream attribution, opens in a new tab"
          className="text-cc-muted hover:text-cc-fg transition-colors"
        >
          Attribution
        </a>
      </div>
    </footer>
  );
}
