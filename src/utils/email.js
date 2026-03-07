import { Resend } from "resend";

const mailHealth = {
  usingResend: true,
  lastSendError: null,
  lastSendId: null,
};

function getResendClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY');
  return new Resend(key);
}

export async function sendEmail({ to, subject, html, text }) {
  if (String(process.env.DEV_EMAIL_DISABLE).toLowerCase() === 'true') {
    console.log(`[mail] DEV_EMAIL_DISABLE=true, skipping email to ${to} (${subject})`);
    return;
  }
  try {
    const resend = getResendClient();
    const from = process.env.EMAIL_FROM || `Flowsnap <no-reply@${new URL(process.env.APP_BASE_URL || 'http://localhost').hostname}>`;
    const result = await resend.emails.send({ from, to, subject, html: html || (text ? `<pre>${text}</pre>` : '') });
    mailHealth.lastSendId = result?.id || null;
    if (String(process.env.MAIL_DEBUG).toLowerCase() === 'true') {
      console.log('[mail] Resend send result:', result);
    }
  } catch (e) {
    mailHealth.lastSendError = e.message;
    console.error('[mail] Resend send failed:', e.message);
  }
}

export function buildAppUrl(path) {
  const base = process.env.FRONTEND_URL || process.env.APP_BASE_URL || "http://localhost:5173";
  return base.replace(/\/$/, "") + path;
}

export function buildApiUrl(path) {
  const base = process.env.APP_BASE_URL || "http://localhost:5000";
  return base.replace(/\/$/, "") + path;
}

export function getEmailHealth() {
  return {
    usingResend: mailHealth.usingResend,
    lastSendId: mailHealth.lastSendId,
    lastSendError: mailHealth.lastSendError,
    debug: String(process.env.MAIL_DEBUG).toLowerCase() === 'true',
  };
}
