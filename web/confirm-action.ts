let pending = false;

/** Dialog native menjaga focus trap dan Escape; isi pesan selalu berupa teks. */
export function confirmAction(message: string): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  pending = true;
  return new Promise(resolve => {
    const trigger = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-modal';
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    dialog.setAttribute('aria-describedby', 'confirm-message');
    const heading = document.createElement('h2');
    heading.id = 'confirm-title';
    heading.textContent = 'Konfirmasi tindakan';
    const body = document.createElement('p');
    body.id = 'confirm-message';
    body.textContent = message;
    const hint = document.createElement('p');
    hint.className = 'helper';
    hint.textContent = 'Periksa data dan dampak perubahan sebelum melanjutkan.';
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Batal';
    cancel.autofocus = true;
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'primary';
    accept.textContent = 'Ya, lanjutkan';
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      pending = false;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      resolve(accepted);
    };
    cancel.onclick = () => finish(false);
    accept.onclick = () => finish(true);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.onclose = () => finish(false);
    actions.append(cancel, accept);
    dialog.append(heading, hint, body, actions);
    // Tetap berada di dialog sumber agar konfirmasi bertingkat tidak menjadi inert.
    (trigger?.closest('dialog[open]') ?? document.body).append(dialog);
    try { dialog.showModal(); cancel.focus(); }
    catch { finish(false); }
  });
}
