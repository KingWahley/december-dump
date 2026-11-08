/* Passflow: browser-side ticket manager.
   Production data uses Supabase Auth + Postgres RLS. No service-role key is used. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cfg = window.TICKET_APP_CONFIG || {};
  const isLive = Boolean(cfg.supabaseUrl?.trim() && cfg.supabaseAnonKey?.trim());
  const storageKey = 'passflow-tickets-v1';
  const settingsKey = 'passflow-event-settings-v1';
  const labels = { dashboard: 'Overview', create: 'Create Ticket', tickets: 'All Tickets', verify: 'Verify Ticket', settings: 'Settings' };
  const defaultSettings = { event_name: 'THE GRAND EXPERIENCE', event_date: '', venue: 'Your event venue' };
  const state = {
    client: null, tickets: [], activeView: 'dashboard',
    draftId: generateTicketId(), selected: null, confirmDraft: null, verifyTicket: null,
    settings: readStorage(settingsKey, defaultSettings), toastTimer: null,
    loggedIn: false, user: null, saving: false, eventId: null
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
  function typeBadge(type) { return `<span class="type-badge ${type === 'VIP' ? 'vip' : type === 'VVIP' ? 'vvip' : ''}">${h(type)}</span>`; }
  function deliveryBadge(status) {
    const names = { not_sent: 'Not sent', whatsapp_opened: 'Chat opened', sent_confirmed: 'Sent ✓' };
    return `<span class="delivery-badge ${status === 'sent_confirmed' ? 'sent' : status === 'whatsapp_opened' ? 'opened' : ''}">${h(names[status] || 'Not sent')}</span>`;
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
    else { button.disabled = false; if (button.dataset.original) button.innerHTML = button.dataset.original; }
  }

  async function init() {
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
        $('modePill').innerHTML = '<i></i> Supabase live';
        $('modePill').classList.add('live');
        $('connectionMode').textContent = 'Supabase — connected';
        $('connectionNote').textContent = 'Ticket records are stored in your Supabase project and protected by row-level security.';
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
      $('connectionMode').textContent = 'Local storage';
      $('connectionNote').textContent = 'Ticket records are stored on this device.';
      $('sidebarEmail').textContent = 'Administrator';
      $('appRoot').classList.remove('hidden');
      renderAll();
    }
  }
  function showLogin() { $('appRoot').classList.add('hidden'); $('authScreen').classList.remove('hidden'); }
  async function authorize(user) {
    const { data, error } = await state.client.from('ticket_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (error) throw new Error(`Admin authorization failed: ${error.message}`);
    if (!data) {
      await state.client.auth.signOut();
      showLogin();
      $('loginError').textContent = 'This account is not authorized. Add the user to ticket_admins in Supabase.';
      $('loginError').classList.remove('hidden');
      return;
    }
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
    $('statVip').textContent = rows.filter((t) => ['VIP','VVIP'].includes(t.ticket_type)).length.toLocaleString();
    $('statSent').textContent = rows.filter((t) => t.delivery_status === 'sent_confirmed').length.toLocaleString();
    $('statPending').textContent = rows.filter((t) => t.delivery_status !== 'sent_confirmed').length.toLocaleString();
    $('recentRows').innerHTML = rows.slice(0,5).map((t) => `<tr><td>${nameCell(t)}</td><td><span class="ticket-id-text">${h(t.ticket_id)}</span></td><td>${typeBadge(t.ticket_type)}</td><td>${deliveryBadge(t.delivery_status)}</td></tr>`).join('') || `<tr><td colspan="4" class="empty-row">No tickets yet. Create your first ticket.</td></tr>`;
  }
  function nameCell(t) { return `<span class="table-name"><span class="table-avatar">${h(initials(t.holder_name))}</span><span>${h(t.holder_name)}</span></span>`; }
  function renderTickets() {
    const q = $('ticketSearch').value.trim().toLowerCase();
    const type = $('ticketFilter').value;
    const list = state.tickets.filter((t) => (type === 'all' || t.ticket_type === type) && [t.ticket_id, t.holder_name, t.phone, t.email].some((value) => String(value || '').toLowerCase().includes(q)));
    $('allTicketRows').innerHTML = list.map((t) => `<tr><td>${nameCell(t)}</td><td><span class="ticket-id-text">${h(t.ticket_id)}</span></td><td>${typeBadge(t.ticket_type)}</td><td>${h(formatCreated(t.created_at))}</td><td>${deliveryBadge(t.delivery_status)}</td><td><button class="table-action" data-open-ticket="${h(t.ticket_id)}">View / send →</button></td></tr>`).join('') || `<tr><td colspan="6" class="empty-row">No tickets match your search.</td></tr>`;
    $('ticketCountLabel').textContent = `${list.length} ticket${list.length === 1 ? '' : 's'} shown`;
  }
  function go(view) {
    if (!labels[view]) return;
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
    return `<div class="pass-ticket"><div class="pass-top"><div class="pass-topline"><span class="pass-brand">passflow<span>.</span></span><small>OFFICIAL EVENT PASS</small></div><div class="pass-event">${h(t.event_name || 'YOUR EVENT')}</div><div class="pass-admission">✦ &nbsp; ${h(String(t.ticket_type).toUpperCase())} ADMISSION</div></div><div class="pass-seam"></div><div class="pass-bottom"><div class="pass-info"><span class="pass-smalllabel">TICKET HOLDER</span><div class="pass-holder">${h(capitalizeName(t.holder_name))}</div><div class="pass-bottom-details"><div><span class="pass-smalllabel">DATE</span><strong class="pass-details-strong">${h(formatDate(t.event_date))}</strong></div><div><span class="pass-smalllabel">VENUE</span><strong class="pass-details-strong">${h(t.venue || 'TBA')}</strong></div></div></div><div class="pass-qrbox"><div class="pass-qr" data-qr="${h(t.ticket_id)}"></div><small>SCAN / VERIFY ID</small></div></div><div class="pass-bottomid"><small>UNIQUE TICKET ID</small><strong>${h(t.ticket_id)}</strong></div></div>`;
  }
  function renderQr(container) {
    if (!container) return;
    if (!window.QRCode) {
      container.querySelectorAll('[data-qr]').forEach((node) => { node.innerHTML = '<span class="qr-fallback">ID<br>CHECK</span>'; });
      return;
    }
    container.querySelectorAll('[data-qr]').forEach((node) => {
      try {
        node.innerHTML = '';
        new window.QRCode(node, { text: node.dataset.qr, width: 80, height: 80, colorDark: '#17283b', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
      } catch (e) { console.warn('QR generation unavailable:', e); }
    });
  }
  function mountTicket(id,t) { const container = $(id); container.innerHTML = ticketHTML(t); renderQr(container); }
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
      let draft = { ticket_id, holder_name, ticket_type, phone: phone || null, email: email || null, event_name, event_date, venue, delivery_status:'not_sent', status:'valid' };
      if (isLive && state.eventId) draft.event_id = state.eventId;
      let saved;
      if (isLive) {
        // The DB primary key is the final authority on uniqueness. Retry collisions.
        for (let attempt = 0; attempt < 4; attempt++) {
          const { data, error } = await state.client.from('tickets').insert(draft).select('*').single();
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
    $('readyTitle').innerHTML = `Ticket ${t.delivery_status === 'sent_confirmed' ? 'details' : 'ready'} <span class="success-inline">✓</span>`;
    $('readyTicketId').textContent = t.ticket_id;
    mountTicket('readyTicket',t);
    $('whatsappButton').classList.toggle('hidden', !t.phone);
    $('emailButton').classList.toggle('hidden', !t.email);
    $('readyInstructions').textContent = t.phone
      ? 'Download the ticket PDF or image first. WhatsApp will open with a prefilled message. Attach the ticket and press Send in WhatsApp. Opening the chat alone does not send anything.'
      : 'This ticket has no WhatsApp number. Download the ticket and print it, or use the email draft and attach the ticket manually.';
    $('markSentButton').textContent = t.delivery_status === 'sent_confirmed' ? '✓ Marked as sent by admin' : '✓ I sent this ticket — mark as sent';
    $('markSentButton').disabled = t.delivery_status === 'sent_confirmed';
    $('shareButton').classList.toggle('hidden', !Boolean(navigator.share && navigator.canShare));
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
      $('markSentButton').textContent = status === 'sent_confirmed' ? '✓ Marked as sent by admin' : '✓ I sent this ticket — mark as sent';
      $('markSentButton').disabled = status === 'sent_confirmed';
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
  async function ticketCanvas(t) {
    const canvas = document.createElement('canvas');
    canvas.width=1500; canvas.height=850;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle='#f4f6f8'; ctx.fillRect(0,0,1500,850);
    ctx.save();
    rounded(ctx,25,25,1450,800,34);ctx.clip();
    const grad=ctx.createLinearGradient(0,0,1500,500);
    grad.addColorStop(0,'#14243a');grad.addColorStop(1,'#2e4b6b');
    ctx.fillStyle=grad;ctx.fillRect(25,25,1450,515);
    ctx.beginPath();ctx.strokeStyle='rgba(255,255,255,0.07)';ctx.lineWidth=80;
    ctx.arc(1430,0,480,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=60;
    ctx.arc(1430,0,305,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle='#ffffff';ctx.font='800 35px Manrope,Arial,sans-serif';ctx.fillText('passflow',90,114);
    ctx.fillStyle='#8ec5ff';ctx.fillText('.',244,114);
    ctx.fillStyle='#bdcde1';ctx.font='700 22px Manrope,Arial,sans-serif';ctx.textAlign='right';ctx.fillText('OFFICIAL EVENT PASS',1400,110);ctx.textAlign='left';
    ctx.fillStyle='#ffffff';fittedText(ctx,t.event_name||'YOUR EVENT',90,285,1270,69,34);
    ctx.fillStyle='#f7d6a4';ctx.font='800 23px Manrope,Arial,sans-serif';ctx.fillText(`✦  ${String(t.ticket_type).toUpperCase()} ADMISSION`,90,376);
    ctx.fillStyle='#fff';ctx.fillRect(25,540,1450,285);
    ctx.fillStyle='#f4f6f8';ctx.beginPath();ctx.arc(25,540,23,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(1475,540,23,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.setLineDash([14,12]);ctx.moveTo(50,540);ctx.lineTo(1450,540);ctx.lineWidth=3;ctx.strokeStyle='#e3e8f0';ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#93a2b5';ctx.font='800 20px Manrope,Arial,sans-serif';ctx.fillText('TICKET HOLDER',90,600);
    ctx.fillStyle='#17263c';fittedText(ctx,capitalizeName(t.holder_name),90,657,950,44,27);
    ctx.fillStyle='#93a2b5';ctx.font='800 17px Manrope,Arial,sans-serif';ctx.fillText('DATE',90,705);ctx.fillText('VENUE',460,705);
    ctx.fillStyle='#233851';ctx.font='700 23px Manrope,Arial,sans-serif';ctx.fillText(formatDate(t.event_date),90,742);
    fittedText(ctx,t.venue||'TBA',460,742,530,23,16);
    ctx.fillStyle='#8ea1b7';ctx.font='800 16px Manrope,Arial,sans-serif';ctx.fillText('TICKET ID',90,792);
    ctx.fillStyle='#466588';ctx.font='800 20px Manrope,Arial,sans-serif';ctx.fillText(t.ticket_id,208,792);
    const qr=await getQrImage(t.ticket_id);
    if (qr) ctx.drawImage(qr,1200,565,197,197);
    else { ctx.strokeStyle='#9dafc4';ctx.lineWidth=3;ctx.strokeRect(1200,565,197,197);ctx.fillStyle='#75889e';ctx.font='700 17px Arial';ctx.textAlign='center';ctx.fillText('VERIFY BY ID',1298,661);ctx.textAlign='left'; }
    ctx.fillStyle='#92a3b5';ctx.font='800 14px Manrope,Arial,sans-serif';ctx.textAlign='center';ctx.fillText('SCAN / VERIFY ID',1298,790);
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
  async function verifyTicket(e) {
    e.preventDefault();
    const id=$('verifyInput').value.trim().toUpperCase();
    if(!id)return;
    const btn=$('verifyButton');setBusy(btn,true,'Checking…');
    state.verifyTicket=null;
    $('verifyResult').classList.remove('hidden');
    $('verifyResult').innerHTML='<p>Searching ticket records…</p>';
    try {
      let ticket;
      if(isLive) {
        const {data,error}=await state.client.from('tickets').select('*').eq('ticket_id',id).maybeSingle();
        if(error)throw error;
        ticket=data;
      } else ticket=state.tickets.find(t=>t.ticket_id.toUpperCase()===id);
      state.verifyTicket=ticket||null;
      renderVerifyResult(ticket);
    }catch(err){$('verifyResult').innerHTML=`<div class="verify-missing">Could not verify ticket: ${h(err.message)}</div>`;}
    finally{setBusy(btn,false);}
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
    $('verifyResult').innerHTML=`<div class="verify-result-head"><span class="${invalid||checked?'bad-head':''}">${invalid?'×':checked?'!':'✓'}</span><div><h3>${heading}</h3><p>${note}</p></div></div><div class="verify-details"><div class="verify-detail"><small>Ticket holder</small><strong>${h(t.holder_name)}</strong></div><div class="verify-detail"><small>Ticket type</small><strong>${h(t.ticket_type)}</strong></div><div class="verify-detail"><small>Ticket ID</small><strong>${h(t.ticket_id)}</strong></div><div class="verify-detail"><small>Status</small><strong>${h(t.status==='checked_in'?'Checked in':t.status==='void'?'Voided':'Valid · not checked in')}</strong></div><div class="verify-detail"><small>Phone</small><strong>${t.phone?'+'+h(t.phone):'Not provided'}</strong></div><div class="verify-detail"><small>Email</small><strong>${h(t.email||'Not provided')}</strong></div><div class="verify-detail"><small>Event</small><strong>${h(t.event_name)}</strong></div><div class="verify-detail"><small>Event date</small><strong>${h(formatDate(t.event_date))}</strong></div></div>${!checked&&!invalid?'<div class="verify-cta"><button class="btn btn-primary" id="checkInButton">✓ Mark as checked in</button></div>':''}`;
    $('checkInButton')?.addEventListener('click',()=>checkIn(t));
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
    $('allTicketRows').addEventListener('click',e=>{const button=e.target.closest('[data-open-ticket]');if(button)void openRecord(button.dataset.openTicket);});
    $('verifyForm').addEventListener('submit',verifyTicket);
    $('settingsForm').addEventListener('submit',saveSettings);
    $('downloadPdfButton').addEventListener('click',downloadPdf);
    $('downloadPngButton').addEventListener('click',downloadPng);
    $('printButton').addEventListener('click',printTicket);
    $('shareButton').addEventListener('click',shareFile);
    $('whatsappButton').addEventListener('click',openWhatsApp);
    $('emailButton').addEventListener('click',openEmail);
    $('copyIdButton').addEventListener('click',copyId);
    $('markSentButton').addEventListener('click',()=>changeDelivery('sent_confirmed'));
    $('createAnotherButton').addEventListener('click',()=>{closeModal('readyModal');newDraft();go('create');});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
