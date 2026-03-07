#!/usr/bin/env node
/*
Generate a Gmail OAuth2 refresh token.
Usage:
  1. Set env vars: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
  2. Run: node scripts/getGmailRefreshToken.js
  3. Open printed authorization URL, consent, you will be redirected to local callback.
  4. Script exchanges code and prints refresh token.
Optional env:
  GMAIL_SCOPE (default: https://www.googleapis.com/auth/gmail.send)
  GMAIL_REDIRECT_PORT (default: 54545)
  GMAIL_REDIRECT_PATH (default: /oauth2callback)
Security: Do NOT commit the refresh token. Add to your .env manually.
*/

import http from 'http';
import { URL, URLSearchParams } from 'url';
import https from 'https';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
console.log(CLIENT_ID);
console.log(CLIENT_SECRET);
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in environment.');
  process.exit(1);
}

const SCOPE = process.env.GMAIL_SCOPE || 'https://www.googleapis.com/auth/gmail.send';
const PORT = Number(process.env.GMAIL_REDIRECT_PORT || 54545);
const CALLBACK_PATH = process.env.GMAIL_REDIRECT_PATH || '/oauth2callback';
const REDIRECT_URI = `http://localhost:${PORT}${CALLBACK_PATH}`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\n=== Gmail OAuth Refresh Token Generator ===');
console.log('Opening authorization URL. If it does not open automatically, copy & paste into your browser:\n');
console.log(authUrl.toString());
console.log('\nWaiting for OAuth callback on', REDIRECT_URI, '\n');

// Try to auto-open (best effort)
try {
  const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  require('child_process').spawn(openCmd, [authUrl.toString()], { stdio: 'ignore', detached: true });
} catch {}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith(CALLBACK_PATH)) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const code = urlObj.searchParams.get('code');
    const error = urlObj.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('OAuth error: ' + error);
      console.error('OAuth error:', error);
      server.close();
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing code parameter.');
      server.close();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Authorization received</h1><p>You may close this tab and return to the terminal.</p>');
    try {
      const tokenData = await exchangeCodeForTokens({ code, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
      if (!tokenData.refresh_token) {
        console.error('\nNo refresh_token returned. Ensure prompt=consent and access_type=offline were included.');
      } else {
        console.log('\nRefresh Token obtained:\n');
        console.log(tokenData.refresh_token);
        maybeAppendEnv(tokenData.refresh_token);
        console.log('\nAdd to .env: GMAIL_REFRESH_TOKEN=' + tokenData.refresh_token);
      }
    } catch (e) {
      console.error('Token exchange failed:', e.message);
    } finally {
      server.close();
    }
  } else {
    res.writeHead(404); res.end();
  }
});

server.listen(PORT).on('error', (e) => {
  console.error('Server error:', e.message);
  process.exit(1);
});

function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri }) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();
    const reqOpts = {
      method: 'POST',
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
      }
    };
    const request = https.request(reqOpts, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error + ' ' + (json.error_description || '')));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    request.on('error', reject);
    request.write(params);
    request.end();
  });
}

function maybeAppendEnv(refreshToken) {
  const envPath = path.join(process.cwd(), '.env');
  try {
    if (fs.existsSync(envPath)) {
      const line = `\nGMAIL_REFRESH_TOKEN=${refreshToken}\n`;
      fs.appendFileSync(envPath, line, { encoding: 'utf8' });
      console.log('Appended GMAIL_REFRESH_TOKEN to .env (verify and remove if committing).');
    }
  } catch (e) {
    console.warn('Could not append to .env:', e.message);
  }
}
