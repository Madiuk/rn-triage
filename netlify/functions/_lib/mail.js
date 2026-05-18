// _lib/mail.js
//
// Outbound email via Resend's REST API. Used for app-sent mail
// (escalation alerts, digests, future notifications). NOT used by
// Supabase Auth's invite/recover flows — those send via Supabase's
// own SMTP transport, which is configured to point at Resend SMTP
// in the Supabase dashboard (Auth → SMTP Settings). Two transports,
// one provider.
//
// Required env vars:
//   - RESEND_API_KEY: from resend.com → API Keys
//   - RESEND_FROM_ADDRESS: full From header value, e.g.
//     'Care Station <notifications@carestation.app>'. The domain
//     in the address must be verified in Resend.
//
// Multi-tenant note: a single product-wide RESEND_FROM_ADDRESS is
// fine pre-launch. When tenant #2 onboards, the from-address likely
// becomes per-tenant (companies.from_address or similar). The
// caller signature stays the same — swap the env-var lookup for a
// tenant lookup at that point.

const { logError } = require('./log');

const RESEND_API = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, html, text, replyTo, tag }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_ADDRESS;

  if (!apiKey || !from) {
    const err = new Error('mail.sendEmail: RESEND_API_KEY or RESEND_FROM_ADDRESS not configured');
    logError('mail.sendEmail.notConfigured', err);
    throw err;
  }
  if (!to || !subject || (!html && !text)) {
    throw new Error('mail.sendEmail: to, subject, and (html or text) are required');
  }

  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject: String(subject),
  };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  if (tag) payload.tags = [{ name: 'category', value: String(tag) }];

  let res;
  try {
    res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logError('mail.sendEmail.network', err, { tag: tag || null });
    throw err;
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    const err = new Error('mail.sendEmail: Resend returned ' + res.status);
    logError('mail.sendEmail.apiError', err, {
      status: res.status,
      body: body.slice(0, 400),
      tag: tag || null,
    });
    throw err;
  }

  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { id: data && data.id ? data.id : null };
}

module.exports = { sendEmail };
