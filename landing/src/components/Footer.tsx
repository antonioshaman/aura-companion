export function Footer() {
  return (
    <footer className="relative z-10 border-t border-cc-border py-10 px-5 sm:px-7 text-center text-sm text-cc-muted">
      <p className="font-mono-code tracking-wide">
        Aura Companion — forked from{" "}
        <a href="https://github.com/The-Vibe-Company/companion" target="_blank" rel="noopener noreferrer" className="hover:text-cc-fg transition-colors">
          The-Vibe-Company/companion
        </a>{" "}
        by{" "}
        <a href="https://thevibecompany.co" target="_blank" rel="noopener noreferrer" className="hover:text-cc-fg transition-colors">
          The Vibe Company
        </a>{" "}
        (MIT)
      </p>
      <div className="flex justify-center gap-6 mt-2">
        <a href="https://github.com/antonioshaman/aura-companion" target="_blank" rel="noopener noreferrer" className="text-cc-muted hover:text-cc-fg transition-colors">
          GitHub
        </a>
        <a href="https://github.com/antonioshaman/aura-companion/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-cc-muted hover:text-cc-fg transition-colors">
          MIT License
        </a>
      </div>
    </footer>
  );
}
