'use client';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { supabase, applyTheme } from '../lib/supabase';

const Ic = ({ n, fill }) => <span className={`ms${fill ? ' fill' : ''}`}>{n}</span>;
const hue = (s) => ([...s].reduce((a, c) => a + c.charCodeAt(0), 0) * 47) % 360;
const DAY = 864e5;
const VIEWS = ['home', 'history', 'contacts', 'chat', 'pay', 'scan', 'receive', 'notifications'];

const when = (d) => {
  const t = new Date(d), n = new Date();
  const day = t.toDateString() === n.toDateString() ? 'Today'
    : t.toDateString() === new Date(n - DAY).toDateString() ? 'Yesterday'
    : t.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day}, ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

// History group label: Today, Yesterday, This week (Mon-Sun), This month, then "September 2026" etc.
const bucket = (d) => {
  const t = new Date(d), n = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const ago = Math.round((day(n) - day(t)) / DAY);
  if (ago <= 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  if (ago <= (n.getDay() + 6) % 7) return 'This week';
  if (t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth()) return 'This month';
  return t.toLocaleDateString([], { month: 'long', year: 'numeric' });
};

function Av({ p, size = 48 }) {
  const s = { width: size, height: size, fontSize: size * 0.42 };
  if (p.dp_url) return <img className="av" style={s} src={p.dp_url} alt="" />;
  if (p.kind === 'business') return <div className="av biz" style={s}><Ic n="storefront" /></div>;
  const h = hue(p.name);
  return <div className="av" style={{ ...s, background: `hsl(${h} 60% 85%)`, color: `hsl(${h} 50% 25%)` }}>{p.name[0]}</div>;
}

function Row({ t, me, onOpen }) {
  const out = t.from_id === me;
  const p = t.other_id && { name: t.other_name, dp_url: t.other_dp, kind: t.other_kind };
  return (
    <div className="tx" onClick={p ? () => onOpen(t.other_id) : undefined}>
      {p ? <Av p={p} /> : <div className="av rw"><Ic n="recycling" /></div>}
      <div className="grow"><b>{p ? p.name : t.title}</b><small>{when(t.created_at)}</small></div>
      <span className={out ? '' : 'in'}>{out ? '-' : '+'}{t.amount}</span>
    </div>
  );
}

function Scan({ onCode, onBack }) {
  const vid = useRef(null);
  const cb = useRef(onCode);
  cb.current = onCode;
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let stream, raf, live = true, lock = false;
    const cv = document.createElement('canvas');
    const tick = () => {
      const v = vid.current;
      if (v && v.readyState === 4) {
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(v, 0, 0);
        const r = jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
        if (r && !lock) { lock = true; cb.current(r.data); setTimeout(() => (lock = false), 2000); }
      }
      if (live) raf = requestAnimationFrame(tick);
    };
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop());
        stream = s; vid.current.srcObject = s; vid.current.play(); tick();
      })
      .catch(() => setMsg('Camera unavailable. Upload a QR image instead.'));
    return () => { live = false; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  const pick = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const r = jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      r ? cb.current(r.data) : setMsg('No QR code found in that image');
    };
    img.src = URL.createObjectURL(f);
  };

  return (
    <div className="scan">
      <video ref={vid} playsInline muted />
      <div className="top2"><button className="ib" onClick={onBack}><Ic n="close" /></button><h1>Scan QR code</h1></div>
      <div className="frame"><i /></div>
      {msg && <div className="smsg">{msg}</div>}
      <label className="gal"><Ic n="photo_library" /><b>Upload from gallery</b><input type="file" accept="image/*" onChange={pick} /></label>
    </div>
  );
}

export default function EcoPay() {
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  const [people, setPeople] = useState([]);
  const [tx, setTx] = useState([]);
  const [notes, setNotes] = useState([]);
  const [fresh, setFresh] = useState([]);
  const [view, setView] = useState('home');
  const [peer, setPeer] = useState(null);
  const [q, setQ] = useState('');
  const [amt, setAmt] = useState('');
  const [note, setNote] = useState('');
  const [st, setSt] = useState('idle');
  const [qr, setQr] = useState('');
  const [toast, setToast] = useState('');
  const user = useRef(null);

  const refresh = async () => {
    const u = user.current;
    const [a, b, c, d] = await Promise.all([
      supabase.rpc('ep_login', { p_id: u.id, p_name: u.name, p_course: u.course, p_dp: u.dp }),
      supabase.rpc('ep_people', { p_id: u.id }),
      supabase.rpc('ep_feed', { p_id: u.id }),
      supabase.rpc('ep_notifs', { p_id: u.id }),
    ]);
    if (a.error || !a.data) return setErr('Could not load EcoPay. Please try again.');
    setMe(a.data); setPeople(b.data || []); setTx(c.data || []); setNotes(d.data || []);
  };

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    applyTheme(sp.get('theme'));
    const u = { id: sp.get('student_id'), name: sp.get('name'), course: sp.get('course') || '', dp: sp.get('dp_url') || '' };
    if (!u.id || !u.name) return setErr('Open EcoPay from your student app to continue.');
    user.current = u;
    refresh();
    const onHash = () => setView(location.hash.slice(1) || 'home');
    onHash();
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (me) QRCode.toDataURL(`ecopay:${me.student_id}`, { width: 400, margin: 1, color: { dark: '#146c2e', light: '#ffffff' } }).then(setQr);
  }, [me?.student_id]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3000); };
  const go = (v) => { location.hash = v; };
  const tab = (v) => location.replace('#' + v);
  const back = () => history.back();
  const openChat = (p) => { setPeer(p); setAmt(''); setNote(''); go('chat'); };
  const openId = (id) => { const p = people.find((x) => x.student_id === id); if (p) openChat(p); };

  const openNotes = () => {
    setFresh(notes.filter((n) => !n.seen).map((n) => n.id));
    setNotes(notes.map((n) => ({ ...n, seen: true })));
    supabase.rpc('ep_read', { p_id: me.student_id });
    go('notifications');
  };

  const onCode = async (txt) => {
    const id = txt.startsWith('ecopay:') ? txt.slice(7) : '';
    if (id === me.student_id) return flash('That is your own QR code');
    const { data } = await supabase.rpc('ep_people', { p_id: me.student_id });
    const p = (data || []).find((x) => x.student_id === id);
    if (!p) return flash('Not a valid EcoPay QR code');
    setPeople(data); setPeer(p); setAmt(''); setNote('');
    tab('pay');
  };

  const pay = async () => {
    const a = parseInt(amt, 10);
    if (!a || a <= 0) return flash('Enter an amount');
    if (a > me.balance) return flash('Not enough EcoPoints');
    setSt('busy');
    const { error } = await supabase.rpc('ep_transfer', { p_from: me.student_id, p_to: peer.student_id, p_amount: a, p_note: note });
    if (error) { setSt('idle'); return flash(error.message); }
    setSt('done');
    await refresh();
    setTimeout(() => { setSt('idle'); setAmt(''); setNote(''); back(); }, 1200);
  };

  const share = async () => {
    const text = `Pay me on EcoPay: ${me.student_id}`;
    if (navigator.share) return navigator.share({ title: 'EcoPay', text }).catch(() => {});
    navigator.clipboard?.writeText(me.student_id);
    flash('ID copied');
  };

  if (err) return <p className="empty" style={{ marginTop: 48 }}>{err}</p>;
  if (!me) return null;

  const v = !VIEWS.includes(view) || ((view === 'chat' || view === 'pay') && !peer) ? 'home' : view;
  const thread = tx.filter((t) => t.other_id === peer?.student_id).reverse();
  const groups = [];
  tx.forEach((t) => {
    const k = bucket(t.created_at), g = groups[groups.length - 1];
    g && g[0] === k ? g[1].push(t) : groups.push([k, [t]]);
  });

  return (
    <div className="app">
      <div className="v" key={v}>
        {v === 'home' && (
          <div className="scroll">
            <div className="top">
              <div className="logo"><Ic n="eco" fill /></div><b>EcoPay</b>
              <button className="ib" onClick={openNotes}><Ic n="notifications" />{notes.some((n) => !n.seen) && <span className="dot" />}</button>
            </div>
            <div className="bal"><p>Available EcoPoints</p><h1><small>EP</small>{me.balance.toLocaleString()}</h1></div>
            <div className="acts">
              <button className="a main" onClick={() => go('scan')}><Ic n="qr_code_scanner" />Scan QR</button>
              <button className="a" onClick={() => go('contacts')}><Ic n="arrow_upward" />Send</button>
              <button className="a" onClick={() => go('receive')}><Ic n="arrow_downward" />Receive</button>
            </div>
            <div className="sec"><h2>People &amp; businesses</h2></div>
            <div className="ppl">
              {people.slice(0, 10).map((p) => (
                <div key={p.student_id} onClick={() => openChat(p)}><Av p={p} size={56} /><span>{p.name.split(' ')[0]}</span></div>
              ))}
            </div>
            <div className="sec"><h2>Recent activity</h2><button className="pill" onClick={() => tab('history')}>View all</button></div>
            <div className="card">
              {tx.slice(0, 3).map((t) => <Row key={t.id} t={t} me={me.student_id} onOpen={openId} />)}
              {!tx.length && <p className="empty">No activity yet</p>}
            </div>
          </div>
        )}

        {v === 'history' && (
          <div className="scroll">
            <div className="top2"><button className="ib" onClick={() => tab('home')}><Ic n="arrow_back" /></button><h1>Transaction history</h1></div>
            {groups.map(([title, l]) => (
              <div key={title} style={{ padding: '0 20px' }}>
                <div className="gt">{title}</div>
                <div className="card" style={{ margin: 0 }}>{l.map((t) => <Row key={t.id} t={t} me={me.student_id} onOpen={openId} />)}</div>
              </div>
            ))}
            {!tx.length && <p className="empty">No transactions yet</p>}
          </div>
        )}

        {v === 'contacts' && (
          <>
            <div className="top2">
              <button className="ib" onClick={back}><Ic n="arrow_back" /></button>
              <div className="search"><Ic n="search" /><input placeholder="Pay anyone on EcoPay" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            </div>
            <div className="scroll list">
              {people.filter((p) => `${p.name} ${p.student_id}`.toLowerCase().includes(q.toLowerCase())).map((p) => (
                <div className="tx" key={p.student_id} onClick={() => openChat(p)}>
                  <Av p={p} />
                  <div className="grow"><b>{p.name}</b><small>{p.kind === 'business' ? 'Business account' : p.course || p.student_id}</small></div>
                </div>
              ))}
            </div>
          </>
        )}

        {v === 'chat' && (
          <>
            <div className="top2">
              <button className="ib" onClick={back}><Ic n="arrow_back" /></button>
              <Av p={peer} size={40} />
              <div className="grow"><b style={{ fontSize: 18, fontWeight: 500 }}>{peer.name}</b><small>{peer.kind === 'business' ? 'Business account' : peer.course || peer.student_id}</small></div>
            </div>
            <div className="chat">
              {!thread.length && <p className="empty">No payments with {peer.name} yet</p>}
              {thread.map((t) => {
                const out = t.from_id === me.student_id;
                return (
                  <div key={t.id} className={`b ${out ? 'r' : 'l'}`}>
                    <b>{out ? 'You paid' : 'Payment received'}</b>
                    <h3>{out ? '-' : '+'} {t.amount} EP</h3>
                    {t.note && <small>{t.note}</small>}<small>{when(t.created_at)}</small>
                  </div>
                );
              })}
            </div>
            <div className="bar"><button className="btn" onClick={() => go('pay')}>Pay</button></div>
          </>
        )}

        {v === 'pay' && (
          <>
            <div className="top2"><button className="ib" onClick={back}><Ic n="arrow_back" /></button><h1>Pay</h1></div>
            <div className="pay">
              <Av p={peer} size={80} />
              <h2>{peer.name}</h2>
              <p>Paying securely with EcoPay · Balance {me.balance.toLocaleString()} EP</p>
              <div className="amt"><span>EP</span><input inputMode="numeric" placeholder="0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/\D/g, ''))} /></div>
              <input className="nt" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="bar">
              <button className={`btn${st === 'done' ? ' ok' : ''}`} disabled={st !== 'idle'} onClick={pay}>
                {st === 'busy' ? <><span className="spin"><Ic n="refresh" /></span>Processing…</> : st === 'done' ? <><Ic n="check_circle" />Paid successfully</> : 'Pay now'}
              </button>
            </div>
          </>
        )}

        {v === 'scan' && <Scan onCode={onCode} onBack={back} />}

        {v === 'receive' && (
          <>
            <div className="top2"><button className="ib" onClick={back}><Ic n="close" /></button><h1>Receive EcoPoints</h1></div>
            <div className="rc">
              <Av p={{ name: me.name, dp_url: me.dp_url }} size={64} />
              <h2>{me.name}</h2><p>{me.student_id}</p>
              {qr && <img className="q" src={qr} alt="Your QR code" />}
              <button className="btn tonal" onClick={share}><Ic n="share" />Share ID</button>
            </div>
          </>
        )}

        {v === 'notifications' && (
          <div className="scroll">
            <div className="top2"><button className="ib" onClick={back}><Ic n="arrow_back" /></button><h1>Notifications</h1></div>
            {notes.map((n) => (
              <div className="nf" key={n.id}>
                <div className="ic"><Ic n="redeem" /></div>
                <div className="grow"><b>{n.title}</b><p>{n.body}</p><small>{when(n.created_at)}</small></div>
                {fresh.includes(n.id) && <span className="u" />}
              </div>
            ))}
            {!notes.length && <p className="empty">No notifications yet</p>}
          </div>
        )}
      </div>

      {(v === 'home' || v === 'history') && (
        <nav className="nav">
          <button className={v === 'home' ? 'on' : ''} onClick={() => tab('home')}><span className="pw"><span className={`ms${v === 'home' ? ' fill' : ''}`}>home</span></span>Home</button>
          <button className={v === 'history' ? 'on' : ''} onClick={() => tab('history')}><span className="pw"><span className={`ms${v === 'history' ? ' fill' : ''}`}>history</span></span>History</button>
        </nav>
      )}
      {toast && <div className="snack">{toast}</div>}
    </div>
  );
}
