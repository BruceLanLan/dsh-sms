const STYLE_ID = 'dsh-sms-styles'
let users = 0

/** Install the client bundle's self-contained settings styles. */
export function installStyles(): () => void {
  let style = document.getElementById(STYLE_ID)
  if (style === null) {
    style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
  }
  users += 1
  return () => {
    users = Math.max(0, users - 1)
    if (users === 0) document.getElementById(STYLE_ID)?.remove()
  }
}

const CSS = `
.dsh-sms-section {
  box-sizing: border-box;
  display: grid;
  gap: 16px;
  width: min(100%, 760px);
  padding: 24px 24px 48px;
  color: var(--dsw-alias-label-primary, #ececf1);
}
.dsh-sms-heading h1 {
  margin: 2px 0 6px;
  font-size: 26px;
  line-height: 1.2;
}
.dsh-sms-heading p { margin: 0; color: var(--dsw-alias-label-secondary, #a8a8b3); }
.dsh-sms-heading .dsh-sms-eyebrow {
  color: var(--dsw-alias-brand-primary, #8ca9ff);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.dsh-sms-card {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l2, #383842);
  border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform, rgba(255,255,255,.025));
}
.dsh-sms-card-title,
.dsh-sms-card-title > div,
.dsh-sms-actions,
.dsh-sms-line {
  display: flex;
  align-items: center;
}
.dsh-sms-card-title { justify-content: space-between; gap: 12px; }
.dsh-sms-card-title > div { gap: 10px; min-width: 0; }
.dsh-sms-card-title span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
  color: var(--dsw-alias-label-secondary, #b6b6c1);
  font-size: 12px;
  font-weight: 700;
}
.dsh-sms-card-title h2 { margin: 0; font-size: 16px; }
.dsh-sms-card-title small {
  color: var(--dsw-alias-label-tertiary, #8e8e99);
  text-align: right;
}
.dsh-sms-body,
.dsh-sms-muted,
.dsh-sms-warning,
.dsh-sms-error,
.dsh-sms-footnote { margin: 0; line-height: 1.5; }
.dsh-sms-body { color: var(--dsw-alias-label-secondary, #b6b6c1); }
.dsh-sms-muted,
.dsh-sms-footnote { color: var(--dsw-alias-label-tertiary, #8e8e99); font-size: 13px; }
.dsh-sms-warning { color: var(--dsw-alias-state-warn-label, #f4c978); }
.dsh-sms-error { color: var(--dsw-alias-state-error-primary, #ff7f86); font-size: 13px; }
.dsh-sms-footnote { padding: 2px 4px; }
.dsh-sms-device {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px dashed var(--dsw-alias-border-l3, #4a4a56);
  border-radius: 10px;
}
.dsh-sms-label {
  color: var(--dsw-alias-label-tertiary, #8e8e99);
  font-size: 12px;
  font-weight: 600;
}
.dsh-sms-code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: clamp(24px, 6vw, 38px);
  letter-spacing: .12em;
}
.dsh-sms-actions { flex-wrap: wrap; gap: 8px; }
.dsh-sms-button {
  box-sizing: border-box;
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  padding: 7px 12px;
  border: 1px solid var(--dsw-alias-border-l2, #454550);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #ececf1);
  font: inherit;
  font-size: 13px;
  line-height: 1.2;
  text-decoration: none;
  cursor: pointer;
}
.dsh-sms-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.dsh-sms-button:focus-visible,
.dsh-sms-form input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #82a4ff); outline-offset: 2px; }
.dsh-sms-button:disabled { opacity: .48; cursor: not-allowed; }
.dsh-sms-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #526fd1);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-sms-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #607dde); }
.dsh-sms-danger { color: var(--dsw-alias-state-error-primary, #ff7f86); }
.dsh-sms-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(255,80,90,.1)); }
.dsh-sms-form { display: grid; gap: 9px; }
.dsh-sms-form label { font-size: 13px; font-weight: 600; }
.dsh-sms-form input {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, #454550);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.14));
  color: var(--dsw-alias-label-primary, #ececf1);
  font: inherit;
}
.dsh-sms-form input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary, #ff7f86); }
.dsh-sms-form input:disabled { opacity: .6; }
.dsh-sms-line { justify-content: space-between; gap: 16px; }
.dsh-sms-line > div:first-child { display: grid; gap: 3px; }
.dsh-sms-line strong {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 22px;
}
.dsh-sms-health,
.dsh-sms-commands dl { display: grid; gap: 8px; margin: 0; }
.dsh-sms-health > div,
.dsh-sms-commands dl > div { display: grid; grid-template-columns: minmax(110px, .36fr) 1fr; gap: 12px; }
.dsh-sms-health dt,
.dsh-sms-commands dt { color: var(--dsw-alias-label-tertiary, #8e8e99); }
.dsh-sms-health dd,
.dsh-sms-commands dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.dsh-sms-commands {
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2, #383842);
  color: var(--dsw-alias-label-secondary, #b6b6c1);
  font-size: 13px;
}
.dsh-sms-commands summary { color: var(--dsw-alias-label-primary, #ececf1); font-weight: 600; cursor: pointer; }
.dsh-sms-commands dl { margin-top: 12px; }
.dsh-sms-commands p { margin: 12px 0 0; }
.dsh-sms-section code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow-wrap: anywhere;
}
.dsh-sms-error-box {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff7f86) 46%, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(255,80,90,.08));
  color: var(--dsw-alias-state-error-primary, #ff7f86);
  font-size: 13px;
}
.dsh-sms-error-box ul { margin: 0; padding-left: 20px; }
@media (max-width: 640px) {
  .dsh-sms-section { padding: 18px 14px 36px; }
  .dsh-sms-card-title,
  .dsh-sms-line { align-items: flex-start; flex-direction: column; }
  .dsh-sms-health > div,
  .dsh-sms-commands dl > div { grid-template-columns: 1fr; gap: 2px; }
}
`
