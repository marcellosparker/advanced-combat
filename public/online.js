"use strict";
// ============================================================
// Battlemax — online layer (accounts, records, leaderboard, feedback)
// Talks to Supabase. Everything here is optional: if config is missing or
// the network fails, the game keeps working offline.
// ============================================================
const CLIENT_VERSION = '0.8.1';
const Online = (() => {
  const cfg = window.AC_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  }) : null;
  let session = null, profile = null;
  const PENDING_KEY = 'advcombat.pendingResults', DEVICE_KEY = 'advcombat.device';
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2));
  const SESSION_ID = uuid();
  function deviceId(){ try { let d = localStorage.getItem(DEVICE_KEY); if (!d) { d = uuid(); localStorage.setItem(DEVICE_KEY, d); } return d; } catch(e){ return null; } }
  // Usage tracking: what happened, never personal details. Fire-and-forget; failures are ignored.
  function track(kind, data){
    if (!configured) return;
    try {
      sb.from('events').insert({ kind, data: data || {}, device_id: deviceId(), session_id: SESSION_ID,
        user_id: signedIn() ? session.user.id : null, client_version: CLIENT_VERSION }).then(() => {}, () => {});
    } catch(e){}
  }

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const errText = e => {
    const code = e && e.code, m = (e && (e.message || e.error_description)) || '';
    if (code === 'over_email_send_rate_limit' || /rate limit|only request this after/i.test(m)) return 'Too many emails sent just now. Wait a few minutes, then try again — and check your junk folder for the first one.';
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox and junk folder for the link.';
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (code === 'user_already_exists' || /already registered/i.test(m)) return 'That email already has an account. Try signing in.';
    return m || 'Something went wrong. Try again.';
  };
  const pwField = (ac) => `<span class="pwWrap"><input id="aPass" type="password" autocomplete="${ac}"><button type="button" class="pwEye" id="aEye" aria-label="Show password" aria-pressed="false">Show</button></span>`;
  function wirePw(){
    const b = $('aEye'), i = $('aPass'); if (!b || !i) return;
    b.onclick = () => { const show = i.type === 'password'; i.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); b.setAttribute('aria-pressed', String(show)); i.focus(); };
  }
  const signedIn = () => !!(session && session.user);

  function loadPending(){ try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch(e){ return []; } }
  function savePending(list){ try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20))); } catch(e){} }

  async function loadProfile(){
    profile = null;
    if (!signedIn()) return;
    const { data, error } = await sb.from('profiles').select('id, display_name').eq('id', session.user.id).maybeSingle();
    if (!error) profile = data;
  }
  function renderChip(){
    const b = document.getElementById('acctBtn');
    if (!b) return;
    b.textContent = '';
    const ic = document.createElement('span'); ic.style.display = 'inline-flex'; ic.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'; b.appendChild(ic);
    const nm = document.createElement('span'); nm.className = 'an';
    nm.textContent = signedIn() ? (profile ? profile.display_name : 'Account') : 'Sign in';
    b.appendChild(nm);
    b.title = signedIn() ? 'Account: ' + nm.textContent : 'Sign in';
    b.classList.toggle('on', signedIn());
  }

  // ---------- results ----------
  function buildResult(){
    if (!G || !G.over || G.mode !== 'ai') return null;
    const me = 'red', foe = 'blue', won = G.over === me;
    const r = won ? rankFor(me, foe) : null;
    if (!G.gid) G.gid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    return {
      id: G.gid, won, player_co: G.co[me], ai_co: G.co[foe], days: G.day,
      win_by: G.winBy === 'hq' || G.winBy === 'rout' ? G.winBy : null,
      rank_letter: r ? r.letter : null, score: r ? r.score : null,
      fog: !!G.fog, luck: !!G.luck, map: 'crossroads',
      stats: { me: stat(me), ai: stat(foe), powers: { me: G.uses[me], ai: G.uses[foe] }, props: { me: propsOf(me), ai: propsOf(foe) } },
      client_version: CLIENT_VERSION
    };
  }
  async function insertResult(row){
    const { error } = await sb.from('games').insert({ ...row, user_id: session.user.id });
    // 23505 = duplicate id: already saved, treat as success
    if (error && error.code !== '23505') throw error;
  }
  async function flushPending(){
    if (!configured || !signedIn()) return 0;
    const list = loadPending(); if (!list.length) return 0;
    const left = []; let saved = 0;
    for (const row of list){ try { await insertResult(row); saved++; } catch(e){ left.push(row); } }
    savePending(left);
    return saved;
  }
  async function onGameOver(){
    if (G && G.over && !G.trackedEnd){
      G.trackedEnd = true;
      track('game_end', { mode: G.mode, winner: G.over, won: G.mode === 'ai' ? G.over === 'red' : null, days: G.day, win_by: G.winBy || null, co: G.co, fog: !!G.fog });
    }
    const row = buildResult();
    if (!row) return;
    const el = () => document.getElementById('vSave');
    const say = (html) => { const e = el(); if (e) e.innerHTML = html; };
    if (!configured){ say(''); return; }
    if (!signedIn()){
      const list = loadPending(); if (!list.some(x => x.id === row.id)){ list.push(row); savePending(list); }
      say(`<button class="linkish" id="vSignIn">Sign in or create an account to save this result</button>`);
      const b = document.getElementById('vSignIn'); if (b) b.onclick = () => { document.getElementById('vic').className = 'fx hide'; openAccount(); };
      return;
    }
    say('Saving result…');
    try { await insertResult(row); say('✓ Saved to your record'); }
    catch(e){
      const list = loadPending(); list.push(row); savePending(list);
      say('Couldn’t reach the server — the result will be saved next time you’re online.');
    }
  }

  // ---------- UI: account ----------
  function notConfigured(){
    modal(`<h2>Online features</h2><p>This copy of the game isn’t connected to a server yet, so accounts, the leaderboard and feedback are off. Everything else works.</p><div class="row"><button class="pri" id="mClose">OK</button></div>`);
    $('mClose').onclick = closeModal;
  }
  function openAccount(tab){
    if (!configured) return notConfigured();
    if (signedIn()) return accountPanel();
    tab = tab || 'in';
    const tabs = `<div class="tabs"><button data-tab="in" class="${tab==='in'?'on':''}">Sign in</button><button data-tab="up" class="${tab==='up'?'on':''}">Create account</button></div>`;
    let body = '';
    if (tab === 'in') body = `
      <label>Email<input id="aEmail" type="email" autocomplete="email" inputmode="email"></label>
      <label>Password${pwField('current-password')}</label>
      <p class="aMsg" id="aMsg"></p>
      <div class="row"><button class="pri" id="aGo">Sign in</button><button id="mClose">Cancel</button></div>
      <p><button class="linkish" id="aForgot">Forgot password?</button></p>`;
    else if (tab === 'up') body = `
      <label>Commander name <small>(3–20 letters, numbers, spaces, _ . -)</small><input id="aName" maxlength="20" autocomplete="nickname"></label>
      <label>Email<input id="aEmail" type="email" autocomplete="email" inputmode="email"></label>
      <label>Password <small>(at least 8 characters)</small>${pwField('new-password')}</label>
      <p class="aMsg" id="aMsg"></p>
      <div class="row"><button class="pri" id="aGo">Create account</button><button id="mClose">Cancel</button></div>`;
    else body = `
      <p>Enter your email and we’ll send a link to set a new password.</p>
      <label>Email<input id="aEmail" type="email" autocomplete="email" inputmode="email"></label>
      <p class="aMsg" id="aMsg"></p>
      <div class="row"><button class="pri" id="aGo">Send link</button><button id="mBackIn">Back</button></div>`;
    modal(`<h2>Your account</h2>${tab==='reset' ? '' : tabs}<div class="form">${body}</div>`);
    $('card').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => openAccount(b.dataset.tab));
    if ($('mClose')) $('mClose').onclick = closeModal;
    if ($('mBackIn')) $('mBackIn').onclick = () => openAccount('in');
    if ($('aForgot')) $('aForgot').onclick = () => openAccount('reset');
    wirePw();
    const msg = (t, ok) => { const m = $('aMsg'); m.textContent = t; m.className = 'aMsg ' + (ok ? 'ok' : 'bad'); };
    $('aGo').onclick = async () => {
      const email = ($('aEmail').value || '').trim();
      const pass = $('aPass') ? $('aPass').value : '';
      if (!/^\S+@\S+\.\S+$/.test(email)) return msg('Enter a valid email.');
      $('aGo').disabled = true;
      try {
        if (tab === 'in'){
          const { error } = await sb.auth.signInWithPassword({ email, password: pass });
          if (error) throw error;
          closeModal(); toast('Signed in');
        } else if (tab === 'up'){
          const name = ($('aName').value || '').trim();
          if (!/^[A-Za-z0-9_ .-]{3,20}$/.test(name)) { $('aGo').disabled = false; return msg('Name must be 3–20 letters, numbers, spaces, _ . or -'); }
          if (pass.length < 8) { $('aGo').disabled = false; return msg('Password needs at least 8 characters.'); }
          const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (data.session) { closeModal(); toast('Welcome, ' + name); }
          else msg('Check your email to confirm your account, then sign in.', true);
        } else {
          const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
          if (error) throw error;
          msg('If that email has an account, a reset link is on its way.', true);
        }
      } catch(e){ msg(errText(e)); }
      $('aGo').disabled = false;
    };
  }
  async function accountPanel(){
    modal(`<h2>Your account</h2><p>Loading…</p>`);
    let games = [];
    const { data } = await sb.from('games').select('won, score, rank_letter, days').order('created_at', { ascending: false }).limit(500);
    if (data) games = data;
    const wins = games.filter(g => g.won).length;
    const best = games.filter(g => g.won && g.score != null).sort((a,b) => b.score - a.score)[0];
    const fastest = games.filter(g => g.won).reduce((m, g) => Math.min(m, g.days), Infinity);
    modal(`<h2>Your account</h2>
      <div class="form">
        <label>Commander name<input id="aName" maxlength="20" value="${esc(profile ? profile.display_name : '')}"></label>
        <p class="aMsg" id="aMsg"></p>
      </div>
      <p>${esc(session.user.email)}</p>
      <div class="kpis">
        <div><b>${games.length}</b><small>Games</small></div>
        <div><b>${wins}</b><small>Wins</small></div>
        <div><b>${games.length ? Math.round(wins/games.length*100) + '%' : '—'}</b><small>Win rate</small></div>
        <div><b>${best ? esc(best.rank_letter) + ' · ' + best.score : '—'}</b><small>Best rank</small></div>
        <div><b>${isFinite(fastest) ? 'Day ' + fastest : '—'}</b><small>Fastest win</small></div>
      </div>
      <div class="row"><button class="pri" id="aSave">Save name</button><button id="aHist">My games</button></div>
      <div class="row"><button id="aOut">Sign out</button><button id="mClose">Close</button></div>`);
    const msg = (t, ok) => { const m = $('aMsg'); m.textContent = t; m.className = 'aMsg ' + (ok ? 'ok' : 'bad'); };
    $('mClose').onclick = closeModal;
    $('aHist').onclick = openHistory;
    $('aOut').onclick = async () => { await sb.auth.signOut(); closeModal(); toast('Signed out'); };
    $('aSave').onclick = async () => {
      const name = ($('aName').value || '').trim();
      if (!/^[A-Za-z0-9_ .-]{3,20}$/.test(name)) return msg('Name must be 3–20 letters, numbers, spaces, _ . or -');
      const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', session.user.id);
      if (error) return msg(error.code === '23505' ? 'That name is taken.' : errText(error));
      profile = { ...(profile || {}), display_name: name }; renderChip(); msg('Saved.', true);
    };
  }
  function newPasswordPrompt(){
    modal(`<h2>Set a new password</h2><div class="form"><label>New password <small>(at least 8 characters)</small>${pwField('new-password')}</label><p class="aMsg" id="aMsg"></p></div>
      <div class="row"><button class="pri" id="aGo">Save password</button></div>`);
    wirePw();
    $('aGo').onclick = async () => {
      const p = $('aPass').value;
      if (p.length < 8) { $('aMsg').textContent = 'At least 8 characters.'; $('aMsg').className = 'aMsg bad'; return; }
      const { error } = await sb.auth.updateUser({ password: p });
      if (error) { $('aMsg').textContent = errText(error); $('aMsg').className = 'aMsg bad'; return; }
      closeModal(); toast('Password updated');
    };
  }

  // ---------- UI: history ----------
  async function openHistory(){
    if (!configured) return notConfigured();
    if (!signedIn()) return openAccount('in');
    modal(`<h2>My games</h2><p>Loading…</p>`);
    const { data, error } = await sb.from('games').select('created_at, won, player_co, ai_co, days, rank_letter, score, win_by, fog').order('created_at', { ascending: false }).limit(30);
    if (error) { modal(`<h2>My games</h2><p>${esc(errText(error))}</p><div class="row"><button id="mClose">Close</button></div>`); $('mClose').onclick = closeModal; return; }
    const pend = loadPending().length;
    let rows = (data || []).map(g => {
      const d = new Date(g.created_at);
      const pc = COS[g.player_co] ? COS[g.player_co].n : g.player_co, ac = COS[g.ai_co] ? COS[g.ai_co].n : g.ai_co;
      return `<div class="hrow ${g.won ? 'w' : 'l'}"><span class="res">${g.won ? 'W' : 'L'}</span>
        <span class="mid"><b>${esc(pc)} vs ${esc(ac)}</b><small>${d.toLocaleDateString()} · Day ${g.days}${g.fog ? ' · Fog' : ''}${g.win_by ? ' · ' + (g.win_by === 'hq' ? 'HQ' : 'Rout') : ''}</small></span>
        <span class="rk rk-${esc(g.rank_letter || 'none')} sm">${g.rank_letter ? esc(g.rank_letter) : '–'}</span></div>`;
    }).join('');
    if (!rows) rows = '<p>No games yet. Finish a game against the AI and it will show up here.</p>';
    modal(`<h2>My games</h2>${pend ? `<p>${pend} result${pend===1?'':'s'} waiting to upload.</p>` : ''}<div class="hist">${rows}</div><div class="row"><button class="pri" id="mClose">Close</button></div>`);
    $('mClose').onclick = closeModal;
  }

  // ---------- UI: leaderboard ----------
  async function openLeaderboard(){
    if (!configured) return notConfigured();
    if (!signedIn()) {
      modal(`<h2>Leaderboard</h2><p>Sign in to see the leaderboard and get your name on it.</p><div class="row"><button class="pri" id="aGoIn">Sign in</button><button id="mClose">Close</button></div>`);
      $('aGoIn').onclick = () => openAccount('in'); $('mClose').onclick = closeModal; return;
    }
    modal(`<h2>Leaderboard</h2><p>Loading…</p>`);
    const { data, error } = await sb.rpc('get_leaderboard', { max_rows: 50 });
    if (error) { modal(`<h2>Leaderboard</h2><p>${esc(errText(error))}</p><div class="row"><button id="mClose">Close</button></div>`); $('mClose').onclick = closeModal; return; }
    const me = session.user.id;
    let rows = (data || []).map((r, i) => `<div class="lrow ${r.user_id === me ? 'me' : ''}"><span class="pos">${i+1}</span><span class="nm2">${esc(r.display_name)}</span>
      <span>${r.wins}/${r.games}</span><span>${r.win_rate == null ? '—' : r.win_rate + '%'}</span><span class="rk rk-${esc(r.best_rank || 'none')} sm">${r.best_rank ? esc(r.best_rank) : '–'}</span></div>`).join('');
    if (!rows) rows = '<p>No finished games yet — be the first.</p>';
    modal(`<h2>Leaderboard</h2><div class="lhead"><span>#</span><span>Commander</span><span>W/G</span><span>Win %</span><span>Best</span></div><div class="lb">${rows}</div><p style="font-size:12px">Games against the AI. Ranked by wins, then win rate, then best score.</p><div class="row"><button class="pri" id="mClose">Close</button></div>`);
    $('mClose').onclick = closeModal;
  }

  // ---------- UI: feedback ----------
  function snapshot(){
    if (!G) return null;
    try {
      const s = JSON.parse(JSON.stringify(G));
      return { day: s.day, turn: s.turn, mode: s.mode, co: s.co, fog: s.fog, luck: s.luck, over: s.over, funds: s.funds, power: s.power,
               units: s.units, owners: s.tiles.map(r => r.map(t => t.owner ? t.owner[0] : '.').join('')), stats: s.stats || null };
    } catch(e){ return null; }
  }
  function openFeedback(){
    if (!configured) return notConfigured();
    if (!signedIn()) {
      modal(`<h2>Send feedback</h2><p>Sign in so we can follow up on your report.</p><div class="row"><button class="pri" id="aGoIn">Sign in</button><button id="mClose">Close</button></div>`);
      $('aGoIn').onclick = () => openAccount('in'); $('mClose').onclick = closeModal; return;
    }
    modal(`<h2>Send feedback</h2><div class="form">
      <label>Type<select id="fCat"><option value="bug">Bug</option><option value="balance">Balance</option><option value="idea">Idea</option><option value="other">Other</option></select></label>
      <label>What happened? <small>(what you did, what you expected, what you saw)</small><textarea id="fMsg" rows="5" maxlength="4000"></textarea></label>
      <label class="check"><input type="checkbox" id="fSnap" checked> Attach the current game state</label>
      <p class="aMsg" id="aMsg"></p></div>
      <div class="row"><button class="pri" id="fGo">Send</button><button id="mClose">Cancel</button></div>`);
    $('mClose').onclick = closeModal;
    $('fGo').onclick = async () => {
      const message = ($('fMsg').value || '').trim();
      const m = $('aMsg');
      if (message.length < 3) { m.textContent = 'Add a few words.'; m.className = 'aMsg bad'; return; }
      $('fGo').disabled = true;
      const context = { game: $('fSnap').checked ? snapshot() : null, settings: { ...settings }, screen: { w: innerWidth, h: innerHeight } };
      const { error } = await sb.from('feedback').insert({ user_id: session.user.id, category: $('fCat').value, message, context, user_agent: navigator.userAgent.slice(0, 400), client_version: CLIENT_VERSION });
      if (error) { m.textContent = errText(error); m.className = 'aMsg bad'; $('fGo').disabled = false; return; }
      closeModal(); toast('Thanks — feedback sent');
    };
  }

  // ---------- boot ----------
  async function init(){
    renderChip();
    if (!configured) return;
    const { data } = await sb.auth.getSession();
    session = data.session;
    track('session_start', { screen: innerWidth + 'x' + innerHeight, resumed: !!(G && G.day > 1) });
    await loadProfile(); renderChip();
    if (signedIn()) { const n = await flushPending(); if (n) toast(`${n} saved result${n===1?'':'s'} uploaded`); }
    sb.auth.onAuthStateChange(async (event, s) => {
      session = s;
      if (event === 'PASSWORD_RECOVERY') newPasswordPrompt();
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // defer: Supabase recommends not awaiting other calls inside this callback
        setTimeout(async () => {
          await loadProfile(); renderChip();
          if (event === 'SIGNED_IN') { const n = await flushPending(); if (n) toast(`${n} saved result${n===1?'':'s'} uploaded`); }
        }, 0);
      }
    });
  }
  return { configured, track, init, openAccount, openHistory, openLeaderboard, openFeedback, onGameOver, signedIn };
})();
document.getElementById('acctBtn').onclick = () => Online.openAccount();
document.getElementById('fbBtn').onclick = () => Online.openFeedback();
Online.init();
