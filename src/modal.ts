/**
 * Build-agnostic confirmation modal.
 *
 * A drop-in, promise-based replacement for window.confirm() styled to match the
 * cyberpunk theme. Like the music system it carries its own inline styles so it
 * renders identically in the standalone GitHub Pages build (which ships no
 * lobby CSS) and the WordPress embed. Resolves true on confirm, false on
 * cancel / backdrop click / Escape.
 */

export interface ConfirmOptions {
  title?:   string;
  confirm?: string;   // confirm button label
  cancel?:  string;   // cancel button label
  danger?:  boolean;  // tint the confirm button red for destructive actions
}

export function confirmModal(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const {
    title   = 'Confirm',
    confirm = 'Confirm',
    cancel  = 'Cancel',
    danger  = true,
  } = opts;

  return new Promise<boolean>(resolve => {
    const accent = danger ? '#ff3b6b' : '#00e5ff';

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', zIndex: '100000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(3,5,10,0.66)', backdropFilter: 'blur(3px)',
      font: '14px/1.5 ui-monospace, "SF Mono", Menlo, monospace',
      animation: 'go3dModalIn .14s ease',
    } as Partial<CSSStyleDeclaration>);

    const box = document.createElement('div');
    Object.assign(box.style, {
      maxWidth: '380px', margin: '20px', padding: '22px 22px 18px',
      background: 'rgba(8,12,20,0.96)', color: '#dfe8f2',
      border: `1px solid ${accent}55`, borderRadius: '12px',
      boxShadow: `0 0 28px ${accent}33, inset 0 0 0 1px rgba(255,255,255,0.02)`,
    } as Partial<CSSStyleDeclaration>);

    const h = document.createElement('div');
    h.textContent = title;
    Object.assign(h.style, {
      color: accent, fontSize: '12px', letterSpacing: '0.14em',
      textTransform: 'uppercase', marginBottom: '10px',
    } as Partial<CSSStyleDeclaration>);

    const p = document.createElement('div');
    p.textContent = message;
    Object.assign(p.style, { marginBottom: '20px', color: '#c4cedb' } as Partial<CSSStyleDeclaration>);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' } as Partial<CSSStyleDeclaration>);

    const mkBtn = (label: string, primary: boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.style, {
        padding: '8px 16px', cursor: 'pointer', borderRadius: '8px',
        font: 'inherit', transition: 'all .12s ease',
        color: primary ? '#04070d' : '#9fb0c4',
        background: primary ? accent : 'transparent',
        border: primary ? `1px solid ${accent}` : '1px solid rgba(120,135,160,0.4)',
        fontWeight: primary ? '600' : '400',
      } as Partial<CSSStyleDeclaration>);
      return b;
    };

    const cancelBtn  = mkBtn(cancel, false);
    const confirmBtn = mkBtn(confirm, true);

    const cleanup = (result: boolean) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter')  cleanup(true);
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup(true));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(false); });
    document.addEventListener('keydown', onKey);

    row.append(cancelBtn, confirmBtn);
    box.append(h, p, row);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    confirmBtn.focus();
  });
}

export interface PromptOptions extends ConfirmOptions {
  placeholder?: string;
  maxLength?:   number;
}

/**
 * Like confirmModal but with a multi-line text field. Resolves with the entered
 * text on confirm, or null on cancel / backdrop / Escape. Same inline styling so
 * it works in both builds.
 */
export function promptModal(message: string, opts: PromptOptions = {}): Promise<string | null> {
  const {
    title       = 'Report a bug',
    confirm     = 'Send',
    cancel      = 'Cancel',
    placeholder = '',
    maxLength   = 2000,
  } = opts;

  return new Promise<string | null>(resolve => {
    const accent = '#00e5ff';

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', zIndex: '100000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(3,5,10,0.66)', backdropFilter: 'blur(3px)',
      font: '14px/1.5 ui-monospace, "SF Mono", Menlo, monospace',
      animation: 'go3dModalIn .14s ease',
    } as Partial<CSSStyleDeclaration>);

    const box = document.createElement('div');
    Object.assign(box.style, {
      width: '440px', maxWidth: 'calc(100vw - 40px)', margin: '20px', padding: '22px 22px 18px',
      background: 'rgba(8,12,20,0.96)', color: '#dfe8f2',
      border: `1px solid ${accent}55`, borderRadius: '12px',
      boxShadow: `0 0 28px ${accent}33, inset 0 0 0 1px rgba(255,255,255,0.02)`,
    } as Partial<CSSStyleDeclaration>);

    const h = document.createElement('div');
    h.textContent = title;
    Object.assign(h.style, {
      color: accent, fontSize: '12px', letterSpacing: '0.14em',
      textTransform: 'uppercase', marginBottom: '10px',
    } as Partial<CSSStyleDeclaration>);

    const p = document.createElement('div');
    p.textContent = message;
    Object.assign(p.style, { marginBottom: '12px', color: '#c4cedb' } as Partial<CSSStyleDeclaration>);

    const ta = document.createElement('textarea');
    ta.placeholder = placeholder;
    ta.maxLength = maxLength;
    ta.rows = 5;
    Object.assign(ta.style, {
      width: '100%', boxSizing: 'border-box', resize: 'vertical', marginBottom: '18px',
      padding: '10px', borderRadius: '8px', font: 'inherit', color: '#dfe8f2',
      background: 'rgba(3,6,12,0.9)', border: '1px solid rgba(120,135,160,0.4)',
    } as Partial<CSSStyleDeclaration>);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' } as Partial<CSSStyleDeclaration>);

    const mkBtn = (label: string, primary: boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.style, {
        padding: '8px 16px', cursor: 'pointer', borderRadius: '8px',
        font: 'inherit', transition: 'all .12s ease',
        color: primary ? '#04070d' : '#9fb0c4',
        background: primary ? accent : 'transparent',
        border: primary ? `1px solid ${accent}` : '1px solid rgba(120,135,160,0.4)',
        fontWeight: primary ? '600' : '400',
      } as Partial<CSSStyleDeclaration>);
      return b;
    };

    const cancelBtn  = mkBtn(cancel, false);
    const confirmBtn = mkBtn(confirm, true);

    const cleanup = (result: string | null) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const submit = () => {
      const v = ta.value.trim();
      cleanup(v ? v : null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup(null);
      // Cmd/Ctrl+Enter submits (plain Enter inserts a newline in the textarea).
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    };

    cancelBtn.addEventListener('click', () => cleanup(null));
    confirmBtn.addEventListener('click', submit);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(null); });
    document.addEventListener('keydown', onKey);

    row.append(cancelBtn, confirmBtn);
    box.append(h, p, ta, row);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    ta.focus();
  });
}
