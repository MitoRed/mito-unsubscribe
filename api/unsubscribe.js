/**
 * Serverless function for the unsubscribe page.
 *
 * Deploy to: Vercel (api/unsubscribe.js) OR Cloudflare Worker (adapt handler).
 *
 * Why this exists:
 *   The unsubscribe.html page can't call Smartlead directly — the API key would
 *   be exposed in client-side JS. This function runs server-side, holds the
 *   key as a secret env var, and forwards the unsubscribe call.
 *
 * Deployment (Vercel):
 *   1. Drop this file at api/unsubscribe.js in any Vercel project tied to
 *      mitoredforbusiness.com (or a subdomain).
 *   2. Add env var SMARTLEAD_API_KEY in Vercel project settings.
 *   3. Point unsubscribe.html at /api/unsubscribe (already configured).
 *
 * Deployment (Cloudflare Workers):
 *   Use the export default { fetch(req, env) } signature instead — adapt the
 *   process.env reference to env.SMARTLEAD_API_KEY.
 *
 * Fallback: if you don't want to deploy a serverless function, point the
 * unsubscribe.html fetch call at a Make.com webhook instead. Make receives
 * the POST, your scenario holds the Smartlead key in a vault ref, and it
 * performs the unsub server-side. See 07_make_scenario_reply_handler.json
 * for the pattern — add a second webhook module with the same unsub HTTP call.
 */

export default async function handler(req, res) {
  // CORS — allow the unsubscribe page to call this from the browser.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, campaign_id } = req.body || {};

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) {
    console.error('SMARTLEAD_API_KEY not configured');
    return res.status(500).json({
      error: 'Server misconfigured',
      detail: 'SMARTLEAD_API_KEY env var is missing from this deployment',
    });
  }

  // DEBUG: surface a non-sensitive preview of the key so we can confirm
  // the right value is wired in. Remove after debugging is done.
  const keyPreview = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)} (len=${apiKey.length})`;

  try {
    // Global unsubscribe — removes the lead from every campaign.
    // API docs: https://help.smartlead.ai/api
    const url = `https://server.smartlead.ai/api/v1/leads/add-lead-to-global-block-list?api_key=${encodeURIComponent(apiKey)}`;
    const body = {
      domain_block_list: [],
      email_block_list: [email],
      client_id: null,
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('Smartlead unsub failed', r.status, text);
      return res.status(502).json({
        error: 'Upstream failure',
        smartlead_status: r.status,
        smartlead_body: text,
        key_preview: keyPreview,
        endpoint: 'add-lead-to-global-block-list',
      });
    }

    // Also log to your own system so you have a record independent of Smartlead.
    // Optional: POST to a Pipedrive update that sets Do-Not-Contact = 'unsub'.
    // Using the person custom field key from .env.pipedrive.
    if (process.env.PIPEDRIVE_API_TOKEN) {
      try {
        const searchUrl = `https://mitoredforbusiness.pipedrive.com/api/v1/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true&limit=1&api_token=${process.env.PIPEDRIVE_API_TOKEN}`;
        const searchRes = await fetch(searchUrl);
        const searchJson = await searchRes.json();
        const personId = searchJson?.data?.items?.[0]?.item?.id;

        if (personId) {
          const updateUrl = `https://mitoredforbusiness.pipedrive.com/api/v1/persons/${personId}?api_token=${process.env.PIPEDRIVE_API_TOKEN}`;
          await fetch(updateUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              '69f679f9315d268973d4b41fdf161b6080e5f78d': 'unsub',
            }),
          });
        }
      } catch (err) {
        console.error('Pipedrive sync failed (non-fatal)', err);
        // Don't block the unsub response on a Pipedrive hiccup.
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unsub handler error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
