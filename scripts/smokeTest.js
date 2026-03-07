// Simple smoke test for core endpoints
// Usage: node scripts/smokeTest.js
import 'dotenv/config';

const BASE = process.env.APP_BASE_URL || 'http://localhost:5000';
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL;
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD;
const TEST_PEER_ID = process.env.TEST_PEER_ID; // optional: a known userId to chat with
const TEST_USER2_EMAIL = process.env.TEST_USER2_EMAIL;
const TEST_USER2_PASSWORD = process.env.TEST_USER2_PASSWORD;

async function post(path, body) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json;
    try { json = await res.json(); } catch { json = {}; }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: e.message, url } };
  }
}

async function postAuth(path, body, token) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    let json;
    try { json = await res.json(); } catch { json = {}; }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: e.message, url } };
  }
}

async function getAuth(path, token) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    let jsonText = await res.text();
    let json;
    try { json = JSON.parse(jsonText); } catch { json = { raw: jsonText }; }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: e.message, url } };
  }
}

async function run() {
  console.log('[smoke] Health');
  const health = await fetch(BASE + '/api/v1/health');
  console.log(' health:', health.status, await health.text());

  const smokeEmail = `smoke_${Date.now()}@example.com`;
  console.log('[smoke] Register', smokeEmail);
  const reg = await post('/api/v1/auth/register', { name: 'Smoke', email: smokeEmail, password: 'Passw0rd!' });
  console.log(' register status:', reg.status, reg.json.message);

  console.log('[smoke] Login (should fail not verified)');
  const login1 = await post('/api/v1/auth/login', { email: smokeEmail, password: 'Passw0rd!' });
  console.log(' login status:', login1.status, login1.json.message);

  console.log('[smoke] Forgot password');
  const fp = await post('/api/v1/auth/forgot-password', { email: smokeEmail });
  console.log(' forgot status:', fp.status, fp.json.message || fp.json.error);
  if (fp.status !== 200) {
    console.log(' forgot debug payload:', fp.json);
  }

  // Optional: Authenticated checks using a pre-verified test user
  if (TEST_USER_EMAIL && TEST_USER_PASSWORD) {
    console.log('[smoke] Login with TEST_USER_EMAIL');
    const login2 = await post('/api/v1/auth/login', { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD });
    console.log(' login TEST status:', login2.status, login2.json.message || 'ok');
    if (login2.status === 200 && login2.json.token) {
      const token = login2.json.token;
      console.log('[smoke] /users/me');
      const me = await getAuth('/api/v1/users/me', token);
      console.log('  me status:', me.status, me.json.user ? 'ok' : me.json.message || me.json.error);

      console.log('[smoke] /chat/conversations');
      const convs = await getAuth('/api/v1/chat/conversations', token);
      console.log('  conversations status:', convs.status, Array.isArray(convs.json.conversations) ? convs.json.conversations.length + ' items' : convs.json.message || convs.json.error);

      // Try to find the newly registered unverified smoke user via search
      console.log('[smoke] Search for new user');
      const search = await getAuth(`/api/v1/users/search?q=${encodeURIComponent(smokeEmail.split('@')[0])}`, token);
      if (search.status === 200 && Array.isArray(search.json.users)) {
        const target = search.json.users.find(u => u.email === smokeEmail);
        if (target) {
          console.log('  found target user:', target._id);
          console.log('[smoke] Open conversation with target');
          const open2 = await postAuth(`/api/v1/chat/conversations/${encodeURIComponent(target._id)}`, undefined, token);
          console.log('   open status:', open2.status, open2.json.conversation ? 'ok' : open2.json.message || open2.json.error);
          if (open2.status === 200 && open2.json.conversation?._id) {
            const cid = open2.json.conversation._id;
            console.log('[smoke] Send message to target conversation');
            const msg2 = await postAuth(`/api/v1/chat/conversations/${encodeURIComponent(cid)}/messages`, { text: 'Hi unverified user from smoke test' }, token);
            console.log('   message status:', msg2.status, msg2.json.message ? 'ok' : msg2.json.message || msg2.json.error);
          }
        } else {
          console.log('  target user not found in search results');
        }
      } else {
        console.log('  search failed:', search.status, search.json.message || search.json.error);
      }

      // If a second test user is provided and verified, try to open a conversation and send a message
      if (TEST_USER2_EMAIL && TEST_USER2_PASSWORD) {
        console.log('[smoke] Login TEST_USER2 (peer)');
        const loginPeer = await post('/api/v1/auth/login', { email: TEST_USER2_EMAIL, password: TEST_USER2_PASSWORD });
        console.log('  peer login status:', loginPeer.status, loginPeer.json.message || 'ok');
        if (loginPeer.status === 200 && loginPeer.json.user?._id) {
          const peerId = loginPeer.json.user._id;
          console.log('[smoke] Open conversation with peer by email');
          const openPeer = await postAuth(`/api/v1/chat/conversations/${encodeURIComponent(peerId)}`, undefined, token);
          console.log('  openPeer status:', openPeer.status, openPeer.json.conversation ? 'ok' : openPeer.json.message || openPeer.json.error);
          if (openPeer.status === 200 && openPeer.json.conversation?._id) {
            const cid2 = openPeer.json.conversation._id;
            console.log('[smoke] Send message to peer');
            const m2 = await postAuth(`/api/v1/chat/conversations/${encodeURIComponent(cid2)}/messages`, { text: 'Hello peer from smoke ' + new Date().toISOString() }, token);
            console.log('  m2 status:', m2.status, m2.json.message ? 'ok' : m2.json.message || m2.json.error);
          }
        }
      } else if (TEST_PEER_ID) {
        console.log('[smoke] Open conversation with TEST_PEER_ID');
        const open = await postAuth(`/api/v1/chat/conversations/${encodeURIComponent(TEST_PEER_ID)}`, undefined, token);
        console.log('  open status:', open.status, open.json.conversation ? 'ok' : open.json.message || open.json.error);
        if (open.status === 200 && open.json.conversation?._id) {
          const cid = open.json.conversation._id;
          console.log('[smoke] Send message to conversation');
          const msg = await postAuth(`/api/v1/chat/conversations/${encodeURIComponent(cid)}/messages`, { text: 'Hello from smoke test ' + new Date().toISOString() }, token);
          console.log('  message status:', msg.status, msg.json.message ? 'ok' : msg.json.message || msg.json.error);
        }
      }
    }
  }

  console.log('[smoke] Done');
}

run().catch(e => { console.error(e); process.exit(1); });
