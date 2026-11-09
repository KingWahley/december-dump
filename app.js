/* MGE: browser-side ticket manager.
   Production data uses Supabase Auth + Postgres RLS. No service-role key is used. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cfg = window.TICKET_APP_CONFIG || {};
  const isLive = Boolean(cfg.supabaseUrl?.trim() && cfg.supabaseAnonKey?.trim());
  const storageKey = 'mge-tickets-v1';
  const settingsKey = 'mge-event-settings-v1';
  const labels = { dashboard: 'Overview', create: 'Create Ticket', tickets: 'All Tickets', verify: 'Verify Ticket', settings: 'Settings' };
  const defaultSettings = { event_name: 'THE GRAND EXPERIENCE', event_date: '', venue: 'Your event venue' };
  const state = {
    client: null, tickets: [], activeView: 'dashboard',
    draftId: generateTicketId(), selected: null, confirmDraft: null, verifyTicket: null,
    settings: readStorage(settingsKey, defaultSettings), toastTimer: null,
    loggedIn: false, user: null, saving: false, eventId: null,
    scanStream: null, scanRaf: 0, scanFacing: 'environment', scanCanvas: null, detector: null
  };

  function readStorage(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
    catch { return fallback; }
  }
  function setStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { toast('Browser storage is unavailable. Changes may not persist.', true); }
  }
  function generateTicketId() {
    const date = new Date();
    const stamp = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const values = new Uint32Array(8);
    crypto.getRandomValues(values);
    return `TKT-${stamp}-${[...values].map((n) => alphabet[n % alphabet.length]).join('')}`;
  }
  function h(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0,2).map(part=>part[0]?.toUpperCase()||'').join(''); }
  function formatDate(value) {
    if (!value) return 'To be announced';
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? 'To be announced' : date.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  }
  function formatCreated(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  }
  function normalizePhone(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    const digits = input.replace(/[^0-9]/g, '');
    // Nigerian domestic input: 080..., 070..., 090..., or 10-digit without its trunk prefix.
    if (/^0[789][01]\d{8}$/.test(digits)) return `234${digits.slice(1)}`;
    if (/^[789][01]\d{8}$/.test(digits) && !input.startsWith('+')) return `234${digits}`;
    if (/^[1-9]\d{9,14}$/.test(digits)) return digits;
    throw new Error('Enter a valid WhatsApp phone number with country code (e.g. +2348031234567).');
  }
  function typeBadge(type) {
    const t = String(type || '');
    const cls = /squad/i.test(t) ? 'vvip' : /pair/i.test(t) ? 'vip' : '';
    return `<span class="type-badge ${cls}">${h(t)}</span>`;
  }
  function deliveryBadge(status) {
    const names = { not_sent: 'Not sent', whatsapp_opened: 'Chat opened', sent_confirmed: 'Sent' };
    const icon = status === 'sent_confirmed' ? '<i data-lucide="check"></i>' : '';
    return `<span class="delivery-badge ${status === 'sent_confirmed' ? 'sent' : status === 'whatsapp_opened' ? 'opened' : ''}">${icon}${h(names[status] || 'Not sent')}</span>`;
  }
  function refreshIcons(root = document) {
    if (window.lucide?.createIcons) {
      try { window.lucide.createIcons({ root }); } catch { window.lucide.createIcons(); }
    }
  }
  function toast(message, isError = false) {
    const box = $('toast');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('error', isError);
    box.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => box.classList.remove('show'), 4300);
  }
  function setBusy(button, busy, waitingLabel) {
    if (!button) return;
    if (busy) { button.dataset.original = button.innerHTML; button.disabled = true; button.textContent = waitingLabel || 'Working…'; }
    else { button.disabled = false; if (button.dataset.original) { button.innerHTML = button.dataset.original; refreshIcons(button); } }
  }

  async function init() {
    refreshIcons();
    bindEvents();
    fillSettingsForm();
    newDraft();
    if (isLive) {
      if (!window.supabase?.createClient) {
        $('authScreen').classList.remove('hidden');
        $('loginError').textContent = 'Supabase library could not load. Check your internet connection and reload.';
        $('loginError').classList.remove('hidden');
        return;
      }
      try {
        state.client = window.supabase.createClient(cfg.supabaseUrl.trim(), cfg.supabaseAnonKey.trim());
        $('logoutButton').classList.remove('hidden');
        const { data: { user }, error } = await state.client.auth.getUser();
        if (error || !user) return showLogin();
        await authorize(user);
      } catch (err) {
        showLogin();
        $('loginError').textContent = `Unable to initialize Supabase: ${err.message}`;
        $('loginError').classList.remove('hidden');
      }
    } else {
      state.tickets = readStorage(storageKey, []);
      if (!Array.isArray(state.tickets)) state.tickets = [];
      $('logoutButton').classList.add('hidden');
      $('sidebarEmail').textContent = 'Administrator';
      $('appRoot').classList.remove('hidden');
      renderAll();
    }
  }
  function showLogin() { $('appRoot').classList.add('hidden'); $('authScreen').classList.remove('hidden'); }
  async function authorize(user) {
    state.user = user;
    state.loggedIn = true;
    $('sidebarEmail').textContent = user.email || 'Authorized admin';
    $('authScreen').classList.add('hidden');
    $('appRoot').classList.remove('hidden');
    await loadEvent();
    await loadTickets();
  }
  async function login(e) {
    e.preventDefault();
    const button = $('loginButton');
    $('loginError').classList.add('hidden');
    setBusy(button, true, 'Signing in…');
    try {
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      const { data, error } = await state.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await authorize(data.user);
    } catch (err) {
      $('loginError').textContent = err.message || 'Unable to sign in.';
      $('loginError').classList.remove('hidden');
    } finally { setBusy(button, false); }
  }
  async function logout() {
    stopScanner();
    if (!isLive) return;
    await state.client.auth.signOut();
    state.user = null;
    state.loggedIn = false;
    state.eventId = null;
    state.tickets = [];
    showLogin();
    $('loginPassword').value = '';
  }
  async function loadTickets() {
    if (isLive) {
      if (!state.loggedIn) return;
      const { data, error } = await state.client.from('tickets').select('*').order('created_at', { ascending: false }).limit(500);
      if (error) { toast(`Could not load ticket records: ${error.message}`, true); return; }
      state.tickets = data || [];
    } else {
      state.tickets = readStorage(storageKey, []);
    }
    renderAll();
  }
  function persistLocal() { if (!isLive) setStorage(storageKey, state.tickets); }
  function renderAll() { renderDashboard(); renderTickets(); updateLivePreview(); }
  function renderDashboard() {
    const rows = state.tickets;
    $('statTotal').textContent = rows.length.toLocaleString();
    $('statVip').textContent = rows.filter((t) => /pair|squad|vip/i.test(t.ticket_type)).length.toLocaleString();
    $('statSent').textContent = rows.filter((t) => t.delivery_status === 'sent_confirmed').length.toLocaleString();
    $('statPending').textContent = rows.filter((t) => t.delivery_status !== 'sent_confirmed').length.toLocaleString();
    $('recentRows').innerHTML = rows.slice(0,5).map((t) => `<tr><td data-label="Holder">${nameCell(t)}</td><td data-label="Ticket ID"><span class="ticket-id-text">${h(t.ticket_id)}</span></td><td data-label="Type">${typeBadge(t.ticket_type)}</td><td data-label="Status">${deliveryBadge(t.delivery_status)}</td></tr>`).join('') || `<tr><td colspan="4" class="empty-row">No tickets yet. Create your first ticket.</td></tr>`;
    refreshIcons($('recentRows'));
  }
  function nameCell(t) { return `<span class="table-name"><span class="table-avatar">${h(initials(t.holder_name))}</span><span>${h(t.holder_name)}</span></span>`; }
  function renderTickets() {
    const q = $('ticketSearch').value.trim().toLowerCase();
    const type = $('ticketFilter').value;
    const list = state.tickets.filter((t) => (type === 'all' || t.ticket_type === type) && [t.ticket_id, t.holder_name, t.phone, t.email, t.issued_by_email].some((value) => String(value || '').toLowerCase().includes(q)));
    $('allTicketRows').innerHTML = list.map((t) => `<tr><td data-label="Holder">${nameCell(t)}</td><td data-label="Ticket ID"><span class="ticket-id-text">${h(t.ticket_id)}</span></td><td data-label="Type">${typeBadge(t.ticket_type)}</td><td data-label="Created">${h(formatCreated(t.created_at))}</td><td data-label="Created by"><span class="creator-email">${h(t.issued_by_email || '—')}</span></td><td data-label="Delivery">${deliveryBadge(t.delivery_status)}</td><td data-label="" class="td-action"><div class="row-actions"><button class="table-action" data-open-ticket="${h(t.ticket_id)}">View / send <i data-lucide="arrow-right"></i></button><button class="table-action table-action-danger" data-delete-ticket="${h(t.ticket_id)}" title="Delete ticket"><i data-lucide="trash-2"></i> Delete</button></div></td></tr>`).join('') || `<tr><td colspan="7" class="empty-row">No tickets match your search.</td></tr>`;
    $('ticketCountLabel').textContent = `${list.length} ticket${list.length === 1 ? '' : 's'} shown`;
    refreshIcons($('allTicketRows'));
  }
  function go(view) {
    if (!labels[view]) return;
    if (view !== 'verify') stopScanner();
    state.activeView = view;
    document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
    document.querySelectorAll('.nav-link').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    $('headerPage').textContent = labels[view];
    closeMenu();
    if (view === 'create') updateLivePreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function newDraft() {
    state.draftId = generateTicketId();
    state.confirmDraft = null;
    $('ticketForm').reset();
    updateLivePreview();
  }
  function capitalizeName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').replace(/(^|[\s\-'’])(\p{L})/gu, (m, sep, ch) => sep + ch.toLocaleUpperCase());
  }
  function collectDraft(validate = false) {
    const name = capitalizeName($('holderName').value);
    const email = $('holderEmail').value.trim().toLowerCase();
    const phoneInput = $('holderPhone').value.trim();
    const type = $('ticketType').value;
    if (validate) {
      if (!name) throw new Error('Enter the ticket holder’s full name.');
      if (!phoneInput && !email) throw new Error('Provide a phone number or email address.');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
    }
    const phone = validate ? normalizePhone(phoneInput) : phoneInput;
    return {
      ticket_id: state.draftId, holder_name: name || 'Guest name', ticket_type: type,
      phone, email, event_name: state.settings.event_name || defaultSettings.event_name,
      event_date: state.settings.event_date || null, venue: state.settings.venue || '',
      delivery_status: 'not_sent', status: 'valid', created_at: new Date().toISOString()
    };
  }
  function ticketHTML(t) {
    const title = `${t.event_name || 'YOUR EVENT'}${t.venue ? ` — ${t.venue}` : ''}`;
    return `<div class="pass-ticket"><div class="pass-main"><div class="pass-banner"><img src="ticket-banner.jpg" alt="" class="pass-banner-img" /></div><div class="pass-body"><div class="pass-headline">${h(title.toUpperCase())}</div><div class="pass-grid"><div class="pass-left-col"><div class="pass-meta-line">DATE: ${h(formatDate(t.event_date).toUpperCase())}</div><div class="pass-meta-line">VENUE: ${h((t.venue || 'TBA').toUpperCase())}</div><div class="pass-barcode-wrap"><div class="pass-qr" data-qr="${h(t.ticket_id)}"></div><div class="pass-barcode-id">${h(t.ticket_id)}</div></div></div><div class="pass-right-col"><div class="pass-flag-row"><span class="ng-flag" aria-hidden="true"></span><span class="pass-holder-line">HOLDER: ${h(capitalizeName(t.holder_name).toUpperCase())}</span></div><div class="pass-table"><div class="pass-table-row"><div class="pass-cell pass-cell-grow">TICKET TYPE: ${h(String(t.ticket_type).toUpperCase())}</div><div class="pass-cell pass-cell-badge">MGE PASS</div></div><div class="pass-table-row"><div class="pass-cell pass-cell-full">ADMIT: ${h(capitalizeName(t.holder_name).toUpperCase())}</div></div></div></div></div></div></div><div class="pass-stub"><span>TICKET</span></div></div>`;
  }
  function renderQr(container) {
    if (!container) return;
    container.querySelectorAll('[data-qr]').forEach((box) => {
      box.innerHTML = '';
      const value = box.dataset.qr || 'TKT-000000';
      if (window.QRCode) {
        try {
          new window.QRCode(box, { text: value, width: 160, height: 160, colorDark: '#000000', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
          return;
        } catch (e) { console.warn('QR generation failed:', e); }
      }
      box.textContent = 'QR';
    });
  }
  function mountTicket(id,t) { const container = $(id); container.innerHTML = ticketHTML(t); renderQr(container); refreshIcons(container); }
  function updateLivePreview() { if ($('draftTicket')) mountTicket('draftTicket', collectDraft(false)); }
  function previewSubmit(e) {
    e.preventDefault();
    try {
      state.confirmDraft = collectDraft(true);
      mountTicket('confirmTicket', state.confirmDraft);
      showModal('confirmModal');
    } catch (err) { toast(err.message, true); }
  }
  async function confirmSave() {
    if (state.saving || !state.confirmDraft) return;
    state.saving = true;
    const button = $('confirmSaveButton');
    setBusy(button, true, 'Saving ticket…');
    try {
      const { ticket_id, holder_name, ticket_type, phone, email, event_name, event_date, venue } = state.confirmDraft;
      const creatorEmail = state.user?.email || 'Local admin';
      let draft = { ticket_id, holder_name, ticket_type, phone: phone || null, email: email || null, event_name, event_date, venue, delivery_status:'not_sent', status:'valid', issued_by_email: creatorEmail };
      if (isLive && state.eventId) draft.event_id = state.eventId;
      let saved;
      if (isLive) {
        // The DB primary key is the final authority on uniqueness. Retry collisions.
        for (let attempt = 0; attempt < 4; attempt++) {
          let { data, error } = await state.client.from('tickets').insert(draft).select('*').single();
          if (error && /issued_by_email/i.test(error.message || '')) {
            const { issued_by_email, ...fallbackDraft } = draft;
            ({ data, error } = await state.client.from('tickets').insert(fallbackDraft).select('*').single());
            if (data) data.issued_by_email = creatorEmail;
          }
          if (!error) { saved = data; break; }
          if (error.code !== '23505') throw error;
          draft.ticket_id = generateTicketId();
        }
        if (!saved) throw new Error('Could not generate a unique ticket ID. Please retry.');
      } else {
        while (state.tickets.some((t) => t.ticket_id === draft.ticket_id)) draft.ticket_id = generateTicketId();
        saved = { ...draft, created_at: new Date().toISOString(), sent_at: null, checked_in_at: null };
        state.tickets.unshift(saved);
        persistLocal();
      }
      if (isLive) await loadTickets(); else renderAll();
      closeModal('confirmModal');
      showReady(saved);
      toast(`Ticket ${saved.ticket_id} saved successfully.`);
    } catch (err) { toast(`Could not save ticket: ${err.message}`, true); }
    finally { state.saving = false; setBusy(button, false); }
  }
  function showModal(id) { $(id).classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeModal(id) { $(id).classList.add('hidden'); if ([...document.querySelectorAll('.modal-backdrop')].every(m=>m.classList.contains('hidden'))) document.body.style.overflow = ''; }
  function showReady(t) {
    state.selected = t;
    $('readyTitle').innerHTML = `Ticket ${t.delivery_status === 'sent_confirmed' ? 'details' : 'ready'} <span class="success-inline"><i data-lucide="check"></i></span>`;
    $('readyTicketId').textContent = t.ticket_id;
    mountTicket('readyTicket',t);
    $('whatsappButton').classList.toggle('hidden', !t.phone);
    $('emailButton').classList.toggle('hidden', !t.email);
    $('readyInstructions').textContent = t.phone
      ? 'Download the ticket PDF or image first. WhatsApp will open with a prefilled message. Attach the ticket and press Send in WhatsApp. Opening the chat alone does not send anything.'
      : 'This ticket has no WhatsApp number. Download the ticket and print it, or use the email draft and attach the ticket manually.';
    $('markSentButton').innerHTML = t.delivery_status === 'sent_confirmed' ? '<i data-lucide="check-check"></i> Marked as sent by admin' : '<i data-lucide="check"></i> I sent this ticket — mark as sent';
    $('markSentButton').disabled = t.delivery_status === 'sent_confirmed';
    $('shareButton').classList.toggle('hidden', !Boolean(navigator.share && navigator.canShare));
    refreshIcons($('readyModal'));
    showModal('readyModal');
  }
  async function openRecord(id) {
    let ticket = state.tickets.find((t) => t.ticket_id === id);
    if (!ticket && isLive) {
      const { data, error } = await state.client.from('tickets').select('*').eq('ticket_id', id).maybeSingle();
      if (error) return toast(error.message, true);
      ticket = data;
    }
    if (ticket) showReady(ticket);
    else toast('Ticket not found. Refresh the directory and try again.', true);
  }
  async function deleteTicket(id, button) {
    if (!id) return;
    const ticket = state.tickets.find((t) => t.ticket_id === id) || (state.selected?.ticket_id === id ? state.selected : null) || (state.verifyTicket?.ticket_id === id ? state.verifyTicket : null);
    const label = ticket ? `${ticket.holder_name} (${id})` : id;
    if (!window.confirm(`Permanently delete ticket ${label}? This action cannot be undone.`)) return;
    setBusy(button, true, 'Deleting…');
    try {
      if (isLive) {
        const { error } = await state.client.from('tickets').delete().eq('ticket_id', id);
        if (error) throw error;
      }
      state.tickets = state.tickets.filter((t) => t.ticket_id !== id);
      persistLocal();
      if (state.selected?.ticket_id === id) {
        state.selected = null;
        closeModal('readyModal');
      }
      if (state.verifyTicket?.ticket_id === id) {
        state.verifyTicket = null;
        $('verifyResult').classList.add('hidden');
        $('verifyResult').innerHTML = '';
      }
      renderAll();
      toast(`Ticket ${id} deleted.`);
    } catch (err) {
      toast(`Could not delete ticket: ${err.message}`, true);
    } finally {
      if (button?.isConnected) setBusy(button, false);
    }
  }
  async function changeDelivery(status) {
    const selected = state.selected;
    if (!selected || selected.delivery_status === 'sent_confirmed') return;
    const updates = { delivery_status: status };
    if (status === 'sent_confirmed') updates.sent_at = new Date().toISOString();
    try {
      if (isLive) {
        const { data, error } = await state.client.from('tickets').update(updates).eq('ticket_id', selected.ticket_id).select('*').single();
        if (error) throw error;
        state.selected = data;
        state.tickets = state.tickets.map(t=>t.ticket_id === data.ticket_id ? data : t);
      } else {
        Object.assign(selected, updates);
        state.tickets = state.tickets.map(t=>t.ticket_id === selected.ticket_id ? selected : t);
        persistLocal();
      }
      renderAll();
      $('markSentButton').innerHTML = status === 'sent_confirmed' ? '<i data-lucide="check-check"></i> Marked as sent by admin' : '<i data-lucide="check"></i> I sent this ticket — mark as sent';
      $('markSentButton').disabled = status === 'sent_confirmed';
      refreshIcons($('markSentButton'));
      if (status === 'sent_confirmed') toast('Marked sent based on your confirmation (not verified by WhatsApp).');
    } catch (err) { toast(`Could not update status: ${err.message}`, true); }
  }
  function messageFor(t) {
    return `Hello ${t.holder_name}! 👋\n\nYour ${t.ticket_type} ticket for ${t.event_name} is ready. 🎟️\n\nTicket ID: ${t.ticket_id}\n${t.event_date ? `Date: ${formatDate(t.event_date)}\n` : ''}${t.venue ? `Venue: ${t.venue}\n` : ''}\nPlease find your ticket attached and keep your unique ID for entry verification.\n\nWe look forward to seeing you!`;
  }
  function openWhatsApp() {
    const t = state.selected;
    if (!t?.phone) return toast('This ticket does not have a WhatsApp phone number.', true);
    let digits;
    try { digits = normalizePhone(t.phone); } catch (err) { return toast(err.message, true); }
    const url = `https://wa.me/${digits}?text=${encodeURIComponent(messageFor(t))}`;
    // Open synchronously inside the click handler to avoid pop-up blockers.
    window.open(url, '_blank', 'noopener,noreferrer');
    if (t.delivery_status === 'not_sent') void changeDelivery('whatsapp_opened');
    toast('WhatsApp opened. Attach your downloaded ticket and press Send there.');
  }
  function openEmail() {
    const t = state.selected;
    if (!t?.email) return;
    const url = `mailto:${encodeURIComponent(t.email)}?subject=${encodeURIComponent(`Your ticket: ${t.event_name}`)}&body=${encodeURIComponent(messageFor(t))}`;
    window.location.href = url;
    toast('Attach the downloaded ticket before sending your email.');
  }
  async function copyId() {
    if (!state.selected) return;
    try { await navigator.clipboard.writeText(state.selected.ticket_id); toast('Ticket ID copied.'); }
    catch { toast('Could not copy. Please select the ID manually.', true); }
  }
  function rounded(ctx,x,y,w,h,r) {
    const radius = Math.min(r,w/2,h/2);
    ctx.beginPath();
    ctx.moveTo(x+radius,y);
    ctx.arcTo(x+w,y,x+w,y+h,radius);
    ctx.arcTo(x+w,y+h,x,y+h,radius);
    ctx.arcTo(x,y+h,x,y,radius);
    ctx.arcTo(x,y,x+w,y,radius);
    ctx.closePath();
  }
  function fittedText(ctx,text,x,y,maxWidth,baseSize,minSize=22) {
    let size=baseSize;
    do { ctx.font=`800 ${size}px Manrope, Arial, sans-serif`; size-=2; }
    while (ctx.measureText(String(text)).width>maxWidth && size>minSize);
    ctx.fillText(String(text),x,y);
  }
  async function getQrImage(text) {
    if (!window.QRCode) return null;
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:-10000px;top:-10000px';
    document.body.appendChild(div);
    try {
      new window.QRCode(div, { text, width:190, height:190, colorDark:'#17283b', colorLight:'#ffffff', correctLevel:window.QRCode.CorrectLevel.M });
      const canvas = div.querySelector('canvas');
      const image = new Image();
      const src = canvas?.toDataURL('image/png') || div.querySelector('img')?.src;
      if (!src) return null;
      await new Promise((resolve,reject)=>{ image.onload=resolve; image.onerror=reject; image.src=src; });
      return image;
    } catch { return null; }
    finally { div.remove(); }
  }
  async function getBannerImage() {
    if (state.bannerImg?.complete && state.bannerImg.naturalWidth) return state.bannerImg;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = 'ticket-banner.jpg'; });
      state.bannerImg = img;
      return img;
    } catch { return null; }
  }
  function drawTopCover(ctx, img, dx, dy, dw, dh) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    // Scale image to fill the destination width, anchored at the very top (sy = 0)
    const scale = Math.max(dw / iw, dh / ih);
    const sw = Math.min(iw, dw / scale);
    const sh = Math.min(ih, dh / scale);
    const sx = Math.max(0, (iw - sw) / 2);
    const sy = 0; // Top-aligned crop: never center vertically
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  function getBarcodeCanvas(text) {
    if (!window.JsBarcode) return null;
    try {
      const c = document.createElement('canvas');
      window.JsBarcode(c, text, { format: 'CODE128', displayValue: false, margin: 14, width: 2, height: 92, lineColor: '#000000', background: '#ffffff' });
      return c;
    } catch { return null; }
  }
  async function ticketCanvas(t) {
    const canvas = document.createElement('canvas');
    canvas.width = 1500; canvas.height = 850;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f2f4f7'; ctx.fillRect(0, 0, 1500, 850);

    // Subtle drop shadow + centered ticket stub
    ctx.save();
    ctx.translate(50, 55);

    const W = 1400, H = 740, stubX = 1245, bannerH = 385;

    ctx.save();
    ctx.shadowColor = 'rgba(10, 18, 32, 0.24)';
    ctx.shadowBlur = 36;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 18;
    rounded(ctx, 0, 0, W, H, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    ctx.save();
    rounded(ctx, 0, 0, W, H, 18);
    ctx.clip();

    // Top event artwork banner — cropped from the top edge (sy = 0)
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, W, bannerH);
    const bannerImg = await getBannerImage();
    if (bannerImg) drawTopCover(ctx, bannerImg, 0, 0, stubX, bannerH);
    ctx.fillStyle = '#07050c';
    ctx.fillRect(stubX, 0, W - stubX, bannerH);

    // White lower body
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, bannerH, W, H - bannerH);

    // Event headline (bold condensed uppercase)
    const headline = `${t.event_name || 'YOUR EVENT'}${t.venue ? ` — ${t.venue}` : ''}`.toUpperCase();
    ctx.fillStyle = '#111111';
    fittedText(ctx, headline, 46, bannerH + 64, stubX - 88, 52, 26);

    // Left column: Date, Venue, QR Code + ID
    ctx.fillStyle = '#151515';
    ctx.font = '800 24px "Bebas Neue", Manrope, Arial, sans-serif';
    ctx.fillText(`DATE: ${formatDate(t.event_date).toUpperCase()}`, 46, bannerH + 112);
    fittedText(ctx, `VENUE: ${(t.venue || 'TBA').toUpperCase()}`, 46, bannerH + 146, 515, 24, 16);

    const qr = await getQrImage(t.ticket_id);
    const qrBoxX = 46, qrBoxY = bannerH + 160, qrBoxSize = 136;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize);
    ctx.strokeStyle = '#181818';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize);
    if (qr) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(qr, qrBoxX + 10, qrBoxY + 10, qrBoxSize - 20, qrBoxSize - 20);
      ctx.restore();
    }
    ctx.fillStyle = '#111111';
    fittedText(ctx, t.ticket_id, qrBoxX + qrBoxSize + 22, qrBoxY + 80, 340, 29, 18);

    // Right column: Nigerian flag + Holder + Boxed Ticket Type table
    const rightX = 575, rightW = stubX - rightX - 38;
    ctx.fillStyle = '#008753';
    ctx.fillRect(rightX, bannerH + 88, 26, 46);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rightX + 26, bannerH + 88, 26, 46);
    ctx.fillStyle = '#008753';
    ctx.fillRect(rightX + 52, bannerH + 88, 26, 46);
    ctx.strokeStyle = '#d5dce4';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rightX, bannerH + 88, 78, 46);

    ctx.fillStyle = '#111111';
    fittedText(ctx, `HOLDER: ${capitalizeName(t.holder_name).toUpperCase()}`, rightX + 96, bannerH + 122, rightW - 96, 28, 17);

    // Boxed table
    const boxY = bannerH + 158, boxH = 124, rowH = 62, splitX = rightX + Math.round(rightW * 0.68);
    ctx.strokeStyle = '#181818';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(rightX, boxY, rightW, boxH);
    ctx.beginPath();
    ctx.moveTo(rightX, boxY + rowH); ctx.lineTo(rightX + rightW, boxY + rowH);
    ctx.moveTo(splitX, boxY); ctx.lineTo(splitX, boxY + rowH);
    ctx.stroke();

    ctx.fillStyle = '#111111';
    fittedText(ctx, `TICKET TYPE: ${String(t.ticket_type).toUpperCase()}`, rightX + 16, boxY + 40, splitX - rightX - 28, 23, 14);
    fittedText(ctx, 'MGE PASS', splitX + 16, boxY + 40, rightX + rightW - splitX - 28, 23, 15);
    fittedText(ctx, `ADMIT: ${capitalizeName(t.holder_name).toUpperCase()}`, rightX + 16, boxY + rowH + 40, rightW - 32, 22, 14);

    // Perforated stub line (white on banner, dark on white body)
    ctx.beginPath();
    ctx.setLineDash([12, 10]);
    ctx.moveTo(stubX, 14); ctx.lineTo(stubX, bannerH);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(stubX, bannerH); ctx.lineTo(stubX, H - 14);
    ctx.strokeStyle = '#222222'; ctx.stroke();
    ctx.setLineDash([]);

    // Vertical "TICKET" text on stub
    ctx.save();
    ctx.translate(stubX + (W - stubX) / 2 + 12, bannerH + (H - bannerH) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#111111';
    ctx.font = '800 36px Manrope, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TICKET', 0, 0);
    ctx.restore();

    // Scalloped perforation notches along left & right edges
    ctx.fillStyle = '#f2f4f7';
    for (let y = 34; y < H - 20; y += 30) {
      ctx.beginPath(); ctx.arc(0, y, 8.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(W, y, 8.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(stubX, 0, 11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(stubX, H, 11, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
    ctx.restore();
    return canvas;
  }
  function downloadBlob(blob,fileName) {
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=fileName;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function canvasBlob(canvas,type='image/png') { return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not export the ticket.')),type)); }
  async function makePdfBlob(t) {
    if (!window.jspdf?.jsPDF) throw new Error('PDF library has not loaded. Check your internet connection or use Ticket image / Print.');
    const canvas=await ticketCanvas(t);
    const pdf=new window.jspdf.jsPDF({ orientation:'landscape', unit:'mm', format:[210,119] });
    pdf.addImage(canvas.toDataURL('image/png'),'PNG',0,0,210,119);
    return pdf.output('blob');
  }
  async function downloadPdf() {
    if (!state.selected) return;
    const button=$('downloadPdfButton');setBusy(button,true,'Preparing PDF…');
    try { downloadBlob(await makePdfBlob(state.selected),`${state.selected.ticket_id}.pdf`);toast('PDF downloaded. Attach it in WhatsApp or email.'); }
    catch(err){toast(err.message,true);} finally{setBusy(button,false);}
  }
  async function downloadPng() {
    if(!state.selected)return;
    const button=$('downloadPngButton');setBusy(button,true,'Preparing image…');
    try {const canvas=await ticketCanvas(state.selected);downloadBlob(await canvasBlob(canvas),`${state.selected.ticket_id}.png`);toast('Ticket image downloaded.');}
    catch(err){toast(err.message,true);}finally{setBusy(button,false);}
  }
  async function printTicket() {
    if (!state.selected) return;
    // Reserve the window synchronously, prior to asynchronous canvas work.
    const popup=window.open('', '_blank');
    if(!popup) return toast('Please allow popups to print tickets.',true);
    popup.document.write('<!doctype html><html><head><title>Preparing ticket…</title></head><body>Preparing printable ticket…</body></html>');
    try {
      const canvas=await ticketCanvas(state.selected);
      const image=canvas.toDataURL('image/png');
      popup.document.open();
      popup.document.write(`<!doctype html><html><head><title>${h(state.selected.ticket_id)}</title><meta charset="utf-8"><style>@page{size:landscape;margin:8mm}html,body{margin:0;padding:0;background:#fff}body{display:grid;place-items:center;min-height:100vh}img{width:100%;max-width:250mm;height:auto;display:block}@media print{body{min-height:auto}}</style></head><body><img src="${image}" alt="Printable ticket"><script>window.onload=function(){window.focus();window.print();};<\/script></body></html>`);
      popup.document.close();
    }catch(err){popup.close();toast(err.message,true);}
  }
  async function shareFile() {
    if(!state.selected || !navigator.share || !navigator.canShare) return toast('File sharing is not supported on this device.',true);
    try {
      const blob=await makePdfBlob(state.selected);
      const file=new File([blob],`${state.selected.ticket_id}.pdf`,{type:'application/pdf'});
      if(!navigator.canShare({files:[file]})) return toast('Your browser cannot share PDF files. Download and attach it instead.',true);
      await navigator.share({files:[file],title:state.selected.event_name,text:messageFor(state.selected)});
      toast('Share sheet opened. Confirm the correct recipient and send in your chosen app.');
    }catch(err){if(err.name!=='AbortError')toast(err.message,true);}
  }
  function extractTicketId(raw) {
    const text = String(raw || '').trim();
    const match = text.match(/TKT-[A-Z0-9-]+/i);
    return (match ? match[0] : text).toUpperCase();
  }
  async function lookupAndVerify(rawId) {
    const id = extractTicketId(rawId);
    if (!id) return;
    $('verifyInput').value = id;
    const btn = $('verifyButton'); setBusy(btn, true, 'Checking…');
    state.verifyTicket = null;
    $('verifyResult').classList.remove('hidden');
    $('verifyResult').innerHTML = '<p>Searching ticket records…</p>';
    try {
      let ticket;
      if (isLive) {
        const { data, error } = await state.client.from('tickets').select('*').eq('ticket_id', id).maybeSingle();
        if (error) throw error;
        ticket = data;
      } else ticket = state.tickets.find((t) => t.ticket_id.toUpperCase() === id);
      state.verifyTicket = ticket || null;
      renderVerifyResult(ticket);
    } catch (err) { $('verifyResult').innerHTML = `<div class="verify-missing">Could not verify ticket: ${h(err.message)}</div>`; }
    finally { setBusy(btn, false); }
  }
  async function verifyTicket(e) {
    e.preventDefault();
    await lookupAndVerify($('verifyInput').value);
  }
  function vibrateSuccess() {
    try {
      if (typeof navigator.vibrate === 'function') navigator.vibrate([120, 50, 160]);
    } catch { /* ignore if unsupported */ }
  }
  async function getDetector() {
    if (state.detector !== undefined && state.detector !== null) return state.detector;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        const wanted = ['qr_code', 'code_128', 'code_39', 'ean_13', 'pdf417', 'aztec', 'data_matrix'].filter((f) => formats.includes(f));
        if (wanted.length) state.detector = new window.BarcodeDetector({ formats: wanted });
      } catch { /* fall back to jsQR / ZXing */ }
    }
    return state.detector;
  }
  function getZxingReader() {
    if (state.zxingReader) return state.zxingReader;
    if (!window.ZXing?.MultiFormatReader) return null;
    const reader = new window.ZXing.MultiFormatReader();
    const hints = new Map();
    if (window.ZXing.DecodeHintType && window.ZXing.BarcodeFormat) {
      hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
      hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
        window.ZXing.BarcodeFormat.QR_CODE,
        window.ZXing.BarcodeFormat.CODE_128,
        window.ZXing.BarcodeFormat.CODE_39
      ]);
    }
    reader.setHints(hints);
    state.zxingHints = hints;
    state.zxingReader = reader;
    return reader;
  }
  function tryJsQrCanvas(canvas) {
    if (!window.jsQR) return null;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      return code?.data || null;
    } catch { return null; }
  }
  function tryZxingCanvas(canvas) {
    const reader = getZxingReader();
    if (!reader || !window.ZXing?.HTMLCanvasElementLuminanceSource) return null;
    for (const invert of [false, true]) {
      try {
        const lum = new window.ZXing.HTMLCanvasElementLuminanceSource(canvas, invert);
        const bitmap = new window.ZXing.BinaryBitmap(new window.ZXing.HybridBinarizer(lum));
        const res = reader.decodeWithState ? reader.decodeWithState(bitmap) : reader.decode(bitmap, state.zxingHints);
        if (res?.getText?.()) return res.getText();
      } catch { /* try next */ }
    }
    return null;
  }
  function renderCropToCanvas(source, sx, sy, sw, sh, maxDim = 960) {
    if (!state.scanCanvas) state.scanCanvas = document.createElement('canvas');
    const scale = Math.min(1.5, maxDim / Math.max(sw, sh, 1));
    const w = Math.max(40, Math.round(sw * scale));
    const h = Math.max(40, Math.round(sh * scale));
    state.scanCanvas.width = w;
    state.scanCanvas.height = h;
    const ctx = state.scanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    return state.scanCanvas;
  }
  async function decodeSource(source, width, height, isStaticImage = false) {
    if (!width || !height) return null;
    const detector = await getDetector();
    if (detector) {
      try {
        const hits = await detector.detect(source);
        if (hits?.length && hits[0].rawValue) return hits[0].rawValue;
      } catch { /* fall through */ }
    }

    const minDim = Math.min(width, height);
    const sqSize = Math.round(minDim * 0.72);
    const sqX = Math.round((width - sqSize) / 2);
    const sqY = Math.round((height - sqSize) / 2);

    const regions = isStaticImage
      ? [
          [0, Math.round(height * 0.45), Math.round(width * 0.45), Math.round(height * 0.55), 900],
          [0, 0, width, height, 1100],
          [0, 0, width, height, 640],
          [sqX, sqY, sqSize, sqSize, 800]
        ]
      : [
          [sqX, sqY, sqSize, sqSize, 640],
          [0, 0, width, height, 720]
        ];

    for (const [sx, sy, sw, sh, maxDim] of regions) {
      const c = renderCropToCanvas(source, sx, sy, sw, sh, maxDim);
      const qrHit = tryJsQrCanvas(c);
      if (qrHit) return qrHit;
      const zxingHit = tryZxingCanvas(c);
      if (zxingHit) return zxingHit;
    }
    return null;
  }
  function stopScanner() {
    if (state.scanRaf) { cancelAnimationFrame(state.scanRaf); state.scanRaf = 0; }
    if (state.scanStream) { state.scanStream.getTracks().forEach((t) => t.stop()); state.scanStream = null; }
    const video = $('scannerVideo');
    if (video) video.srcObject = null;
    $('scannerBox')?.classList.add('hidden');
    if ($('scanToggleButton')) {
      $('scanToggleButton').innerHTML = '<i data-lucide="camera"></i> Scan with camera';
      refreshIcons($('scanToggleButton'));
    }
  }
  async function startScanner() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return toast('Camera access is not available in this browser. Use "Scan from image" or type the ID.', true);
    }
    stopScanner();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: state.scanFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      state.scanStream = stream;
      const video = $('scannerVideo');
      video.srcObject = stream;
      await video.play();
      $('scannerBox').classList.remove('hidden');
      $('scanToggleButton').innerHTML = '<i data-lucide="camera-off"></i> Stop camera';
      refreshIcons($('scanToggleButton'));
      $('scannerStatus').textContent = 'Align the ticket QR code inside the square…';
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const cams = devices.filter((d) => d.kind === 'videoinput');
      $('switchCameraButton').classList.toggle('hidden', cams.length < 2);
      const tick = async () => {
        if (!state.scanStream) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const raw = await decodeSource(video, video.videoWidth, video.videoHeight, false);
          if (raw) {
            const id = extractTicketId(raw);
            if (id) {
              vibrateSuccess();
              stopScanner();
              toast(`Scanned ${id}`);
              await lookupAndVerify(id);
              return;
            }
          }
        }
        state.scanRaf = requestAnimationFrame(tick);
      };
      state.scanRaf = requestAnimationFrame(tick);
    } catch (err) {
      stopScanner();
      const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      toast(denied ? 'Camera permission was denied. Allow camera access or use "Scan from image".' : `Could not start camera: ${err.message}`, true);
    }
  }
  function toggleScanner() {
    if (state.scanStream) stopScanner();
    else void startScanner();
  }
  async function flipCamera() {
    state.scanFacing = state.scanFacing === 'environment' ? 'user' : 'environment';
    if (state.scanStream) await startScanner();
  }
  async function scanFromImage(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Could not read the selected image.'));
        el.src = url;
      });
      URL.revokeObjectURL(url);
      const raw = await decodeSource(img, img.naturalWidth || img.width, img.naturalHeight || img.height, true);
      if (!raw) return toast('No ticket QR code was detected in that image.', true);
      const id = extractTicketId(raw);
      vibrateSuccess();
      toast(`Scanned ${id}`);
      await lookupAndVerify(id);
    } catch (err) { toast(err.message || 'Could not scan image.', true); }
  }
  function renderVerifyResult(t) {
    if (!t) {
      $('verifyResult').innerHTML='<div class="verify-missing"><strong>Ticket not found.</strong><br>No ticket matches that ID. Double-check the printed number and try again.</div>';
      return;
    }
    const checked=t.status==='checked_in';
    const invalid=t.status==='void';
    const heading=invalid?'Ticket voided':checked?'Already checked in':'Valid ticket found';
    const note=invalid?'This ticket is not valid for entry.':checked?'This ID has already been used for admission.':'This ID belongs to the guest shown below.';
    const headIcon=invalid?'x-circle':checked?'alert-triangle':'check-circle-2';
    $('verifyResult').innerHTML=`<div class="verify-result-head"><span class="${invalid||checked?'bad-head':''}"><i data-lucide="${headIcon}"></i></span><div><h3>${heading}</h3><p>${note}</p></div></div><div class="verify-details"><div class="verify-detail"><small>Ticket holder</small><strong>${h(t.holder_name)}</strong></div><div class="verify-detail"><small>Ticket type</small><strong>${h(t.ticket_type)}</strong></div><div class="verify-detail"><small>Ticket ID</small><strong>${h(t.ticket_id)}</strong></div><div class="verify-detail"><small>Status</small><strong>${h(t.status==='checked_in'?'Checked in':t.status==='void'?'Voided':'Valid · not checked in')}</strong></div><div class="verify-detail"><small>Phone</small><strong>${t.phone?'+'+h(t.phone):'Not provided'}</strong></div><div class="verify-detail"><small>Email</small><strong>${h(t.email||'Not provided')}</strong></div><div class="verify-detail"><small>Event</small><strong>${h(t.event_name)}</strong></div><div class="verify-detail"><small>Event date</small><strong>${h(formatDate(t.event_date))}</strong></div></div><div class="verify-cta">${!checked&&!invalid?'<button class="btn btn-primary" id="checkInButton"><i data-lucide="user-check"></i> Mark as checked in</button>':''}<button class="btn btn-outline" id="scanAnotherButton"><i data-lucide="scan-line"></i> Scan another ticket</button></div>`;
    refreshIcons($('verifyResult'));
    $('checkInButton')?.addEventListener('click',()=>checkIn(t));
    $('scanAnotherButton')?.addEventListener('click',()=>{
      state.verifyTicket = null;
      $('verifyInput').value = '';
      $('verifyResult').classList.add('hidden');
      $('verifyResult').innerHTML = '';
      void startScanner();
    });
  }
  async function checkIn(t) {
    if(!t || t.status!=='valid')return;
    if(!window.confirm(`Check in ${t.holder_name} with ticket ${t.ticket_id}?`))return;
    const btn=$('checkInButton');setBusy(btn,true,'Checking in…');
    try {
      let updated;
      if(isLive){
        // Conditional update allows only one simultaneous check-in to transition valid -> checked_in.
        const {data,error}=await state.client.from('tickets').update({status:'checked_in',checked_in_at:new Date().toISOString()}).eq('ticket_id',t.ticket_id).eq('status','valid').select('*');
        if(error)throw error;
        if(!data?.length){
          const {data:latest,error:lookupError}=await state.client.from('tickets').select('*').eq('ticket_id',t.ticket_id).single();
          if(lookupError)throw lookupError;
          renderVerifyResult(latest);
          return toast('This ticket has already been checked in or changed by another admin.',true);
        }
        updated=data[0];
      } else {
        updated={...t,status:'checked_in',checked_in_at:new Date().toISOString()};
        state.tickets=state.tickets.map(row=>row.ticket_id===t.ticket_id?updated:row);
        persistLocal();
      }
      state.verifyTicket=updated;
      state.tickets=state.tickets.map(row=>row.ticket_id===updated.ticket_id?updated:row);
      renderAll();renderVerifyResult(updated);
      toast('Ticket checked in successfully.');
    }catch(err){toast(`Unable to check in: ${err.message}`,true);}
    finally{if(btn?.isConnected)setBusy(btn,false);}
  }
  async function loadEvent() {
    if (!isLive || !state.loggedIn) return;
    const { data, error } = await state.client.from('events').select('*').eq('is_active', true).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (error) { toast(`Could not load event details: ${error.message}`, true); return; }
    if (data) {
      state.eventId = data.id;
      state.settings = { event_name: data.event_name, event_date: data.event_date || '', venue: data.venue || '' };
    } else {
      state.eventId = null;
    }
    fillSettingsForm();
    updateLivePreview();
  }
  function fillSettingsForm() {
    $('settingsEventName').value=state.settings.event_name||defaultSettings.event_name;
    $('settingsEventDate').value=state.settings.event_date||'';
    $('settingsVenue').value=state.settings.venue||'';
  }
  async function saveSettings(e) {
    e.preventDefault();
    const name=$('settingsEventName').value.trim();
    if(!name)return toast('Event name cannot be empty.',true);
    const next={event_name:name,event_date:$('settingsEventDate').value,venue:$('settingsVenue').value.trim()};
    if (isLive) {
      const btn = e.submitter || $('settingsForm').querySelector('[type="submit"]');
      setBusy(btn, true, 'Saving…');
      try {
        const row = { event_name: next.event_name, event_date: next.event_date || null, venue: next.venue || null, is_active: true, updated_at: new Date().toISOString() };
        const query = state.eventId
          ? state.client.from('events').update(row).eq('id', state.eventId)
          : state.client.from('events').insert(row);
        const { data, error } = await query.select('*').single();
        if (error) throw error;
        state.eventId = data.id;
      } catch (err) { toast(`Could not save event details: ${err.message}`, true); return; }
      finally { setBusy(btn, false); }
    }
    state.settings=next;
    setStorage(settingsKey,state.settings);
    updateLivePreview();
    toast('Event details saved. Previously issued tickets are unchanged.');
  }
  function openMenu() { $('sidebar').classList.add('open');$('mobileShade').classList.remove('hidden'); }
  function closeMenu() { $('sidebar').classList.remove('open');$('mobileShade').classList.add('hidden'); }
  function bindEvents() {
    document.querySelectorAll('[data-view],[data-go]').forEach(btn=>btn.addEventListener('click',()=>go(btn.dataset.view||btn.dataset.go)));
    document.querySelectorAll('[data-close]').forEach(btn=>btn.addEventListener('click',()=>closeModal(btn.dataset.close)));
    document.querySelectorAll('.modal-backdrop').forEach(backdrop=>backdrop.addEventListener('click',(e)=>{if(e.target===backdrop)closeModal(backdrop.id);}));
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m=>closeModal(m.id));closeMenu();}});
    $('menuButton').addEventListener('click',()=>$('sidebar').classList.contains('open')?closeMenu():openMenu());
    $('mobileShade').addEventListener('click',closeMenu);
    $('loginForm').addEventListener('submit',login);
    $('logoutButton').addEventListener('click',logout);
    $('ticketForm').addEventListener('submit',previewSubmit);
    $('ticketForm').addEventListener('input',updateLivePreview);
    $('ticketForm').addEventListener('change',updateLivePreview);
    $('resetDraft').addEventListener('click',newDraft);
    $('confirmSaveButton').addEventListener('click',confirmSave);
    $('ticketSearch').addEventListener('input',renderTickets);
    $('ticketFilter').addEventListener('change',renderTickets);
    $('refreshButton').addEventListener('click',async()=>{await loadTickets();toast('Ticket list refreshed.');});
    $('allTicketRows').addEventListener('click',e=>{
      const openBtn=e.target.closest('[data-open-ticket]');
      if(openBtn)return void openRecord(openBtn.dataset.openTicket);
      const delBtn=e.target.closest('[data-delete-ticket]');
      if(delBtn)return void deleteTicket(delBtn.dataset.deleteTicket, delBtn);
    });
    $('verifyForm').addEventListener('submit',verifyTicket);
    $('scanToggleButton').addEventListener('click',toggleScanner);
    $('stopScanButton').addEventListener('click',stopScanner);
    $('switchCameraButton').addEventListener('click',flipCamera);
    $('scanImageButton').addEventListener('click',()=>$('scanImageInput').click());
    $('scanImageInput').addEventListener('change',scanFromImage);
    $('settingsForm').addEventListener('submit',saveSettings);
    $('downloadPdfButton').addEventListener('click',downloadPdf);
    $('downloadPngButton').addEventListener('click',downloadPng);
    $('printButton').addEventListener('click',printTicket);
    $('shareButton').addEventListener('click',shareFile);
    $('whatsappButton').addEventListener('click',openWhatsApp);
    $('emailButton').addEventListener('click',openEmail);
    $('copyIdButton').addEventListener('click',copyId);
    $('markSentButton').addEventListener('click',()=>changeDelivery('sent_confirmed'));
    $('deleteTicketButton').addEventListener('click',()=>deleteTicket(state.selected?.ticket_id, $('deleteTicketButton')));
    $('createAnotherButton').addEventListener('click',()=>{closeModal('readyModal');newDraft();go('create');});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
