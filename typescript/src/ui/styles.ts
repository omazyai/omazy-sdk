// The optional stylesheet. The components are unstyled without it: they carry
// class names (`omz-*`) and state attributes (`data-status`, `aria-*`) a
// product styles with its own design system. This sheet is a small default
// that reads only CSS variables, so a product can theme it by setting them.
// The build also writes it to `dist/ui/styles.css` (`@omazyai/sdk/ui/styles.css`).

export const UI_CSS = `/* @omazyai/sdk/ui: optional default styles. Theme with the --omz-* variables. */
.omz {
  --omz-font: inherit;
  --omz-fg: #1b1d21;
  --omz-muted: #5c6370;
  --omz-bg: #ffffff;
  --omz-surface: #f6f7f9;
  --omz-border: #d6d9df;
  --omz-accent: #2f5bd3;
  --omz-accent-fg: #ffffff;
  --omz-danger: #b42318;
  --omz-ok: #1a7f37;
  --omz-warn: #9a6700;
  --omz-focus: #2f5bd3;
  --omz-radius: 8px;
  --omz-gap: 0.75rem;
  --omz-transition: 120ms ease-out;
  font: var(--omz-font);
  color: var(--omz-fg);
}
@media (prefers-color-scheme: dark) {
  .omz {
    --omz-fg: #e8eaee;
    --omz-muted: #a3a9b4;
    --omz-bg: #16181c;
    --omz-surface: #1f2228;
    --omz-border: #383d46;
    --omz-accent: #7c9cf0;
    --omz-accent-fg: #0e1116;
    --omz-danger: #f97066;
    --omz-ok: #4ac26b;
    --omz-warn: #d4a72c;
    --omz-focus: #7c9cf0;
  }
}
.omz *, .omz *::before, .omz *::after { box-sizing: border-box; }
.omz-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.omz :focus-visible { outline: 2px solid var(--omz-focus); outline-offset: 2px; }
.omz-btn {
  font: inherit; cursor: pointer; padding: 0.4rem 0.85rem; min-height: 2.25rem;
  border: 1px solid var(--omz-border); border-radius: var(--omz-radius);
  background: var(--omz-bg); color: var(--omz-fg); transition: background var(--omz-transition);
}
.omz-btn:hover:not(:disabled) { background: var(--omz-surface); }
.omz-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.omz-btn--primary { background: var(--omz-accent); border-color: var(--omz-accent); color: var(--omz-accent-fg); }
.omz-btn--primary:hover:not(:disabled) { background: var(--omz-accent); filter: brightness(1.08); }
.omz-btn--danger { color: var(--omz-danger); border-color: currentColor; }
.omz-input, .omz-field input, .omz-field select, .omz-field textarea {
  font: inherit; color: inherit; background: var(--omz-bg); width: 100%;
  border: 1px solid var(--omz-border); border-radius: var(--omz-radius); padding: 0.45rem 0.6rem;
}
.omz-field { display: grid; gap: 0.25rem; }
.omz-field > span { font-size: 0.875em; color: var(--omz-muted); }
.omz-form { display: flex; flex-wrap: wrap; gap: var(--omz-gap); align-items: end; }
.omz-form .omz-field { flex: 1 1 8rem; }
.omz-error { color: var(--omz-danger); margin: 0.5rem 0; }
.omz-note { color: var(--omz-muted); margin: 0.5rem 0; }
.omz-meta { color: var(--omz-muted); font-size: 0.875em; margin: 0.25rem 0; }
.omz-badge {
  display: inline-block; font-size: 0.75em; padding: 0.05rem 0.45rem; border-radius: 999px;
  border: 1px solid var(--omz-border); color: var(--omz-muted); vertical-align: middle;
}
.omz-badge[data-status="unverified"] { color: var(--omz-warn); border-color: currentColor; }

.omz-panel { display: flex; flex-direction: column; gap: var(--omz-gap); min-height: 0; }
.omz-log { display: flex; flex-direction: column; gap: var(--omz-gap); overflow-y: auto; min-height: 0; }
.omz-msg { display: grid; gap: 0.35rem; max-width: 100%; }
.omz-msg--user { justify-self: end; background: var(--omz-surface); border-radius: var(--omz-radius); padding: 0.5rem 0.75rem; }
.omz-msg__who { font-size: 0.75em; color: var(--omz-muted); }
.omz-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.omz-working { color: var(--omz-muted); }
.omz-working::after { content: ""; display: inline-block; width: 1.2em; text-align: left; animation: omz-dots 1.2s steps(4, end) infinite; }
@keyframes omz-dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
.omz-composer { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: end; }
.omz-composer textarea { resize: vertical; min-height: 2.5rem; max-height: 12rem; }

.omz-card {
  border: 1px solid var(--omz-border); border-radius: var(--omz-radius); background: var(--omz-bg);
  padding: 0.75rem 0.9rem; display: grid; gap: 0.5rem;
}
.omz-card__title { margin: 0; font-size: 1em; font-weight: 600; }
.omz-card__summary { margin: 0; }
.omz-card__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.omz-card[data-status="waiting"] { border-color: var(--omz-accent); }
.omz-status { margin: 0; font-size: 0.925em; }
.omz-status[data-status="confirmed"], .omz-status[data-status="executed"], .omz-status[data-status="done"] { color: var(--omz-ok); }
.omz-status[data-status="failed"], .omz-status[data-status="stale"], .omz-status[data-status="refused"] { color: var(--omz-danger); }
.omz-diff { width: 100%; border-collapse: collapse; font-size: 0.925em; }
.omz-diff th, .omz-diff td { text-align: left; padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--omz-border); vertical-align: top; overflow-wrap: anywhere; }
.omz-diff th { color: var(--omz-muted); font-weight: 500; }
.omz-diff tr[data-changed="true"] td:last-child { font-weight: 600; }
.omz-rows { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 0.75rem; }
.omz-rows dt { color: var(--omz-muted); }
.omz-rows dd { margin: 0; overflow-wrap: anywhere; }

.omz-section { display: grid; gap: var(--omz-gap); }
.omz-section > h2, .omz-section > h3 { margin: 0; font-size: 1.05em; }
.omz-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.omz-item { border: 1px solid var(--omz-border); border-radius: var(--omz-radius); padding: 0.6rem 0.75rem; display: grid; gap: 0.35rem; }
.omz-item__row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; justify-content: space-between; }
.omz-inbox { display: grid; gap: var(--omz-gap); grid-template-columns: minmax(14rem, 1fr) 2fr; }
@media (max-width: 48rem) { .omz-inbox { grid-template-columns: 1fr; } }
.omz-inbox__pick {
  font: inherit; color: inherit; text-align: left; width: 100%; cursor: pointer;
  background: var(--omz-bg); border: 1px solid var(--omz-border); border-radius: var(--omz-radius); padding: 0.55rem 0.7rem;
}
.omz-inbox__pick[aria-current="true"] { border-color: var(--omz-accent); background: var(--omz-surface); }
.omz-stepup { border: 1px dashed var(--omz-accent); border-radius: var(--omz-radius); padding: 0.75rem; }
.omz-confirm { display: inline-flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }

@media (prefers-reduced-motion: reduce) {
  .omz *, .omz *::before, .omz *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  .omz-working::after { content: "..."; }
}
`
