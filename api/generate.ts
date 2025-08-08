// /api/generate.ts
export const config = { runtime: 'edge' };

// Read allow-list, support wildcards like "*.vercel.app"
const RAW_ALLOW = (process.env.ALLOW_ORIGINS || '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

function originAllowed(origin: string): boolean {
  if (!RAW_ALLOW.length) return true;      // allow all if empty
  if (!origin) return true;                // direct server calls
  let host = '';
  try { host = new URL(origin).host; } catch { return false; }

  for (const pat of RAW_ALLOW) {
    if (!pat) continue;
    if (pat.startsWith('http://') || pat.startsWith('https://')) {
      if (origin === pat) return true;
    }
    if (pat.startsWith('*.')) {            // wildcard domain
      if (host.endsWith(pat.slice(1))) return true;
    }
    if (pat === host) return true;         // bare host
    if (pat === origin) return true;       // exact origin
  }
  return false;
}

function corsHeaders(origin: string) {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (!origin || originAllowed(origin)) {
    h['access-control-allow-origin'] = origin || '*';
    h['access-control-allow-headers'] = 'content-type,x-app-token';
    h['access-control-allow-methods'] = 'POST,OPTIONS';
  }
  return h;
}

const APP_TOKEN = process.env.APP_TOKEN || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');

export default async function handler(req: Request) {
  const origin = req.headers.get('origin') || '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // Block only if an Origin is present and not allowlisted
  if (origin && !originAllowed(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403, headers: corsHeaders(origin)
    });
  }

  // Friendly method error
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: corsHeaders(origin)
    });
  }

  // App token check
  if (APP_TOKEN) {
    const token = req.headers.get('x-app-token') || '';
    if (token !== APP_TOKEN) {
      return new Response(JSON.stringify({ error: 'Invalid app token' }), {
        status: 401, headers: corsHeaders(origin)
      });
    }
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: corsHeaders(origin)
    });
  }

  const { messages, model, temperature = 0.7, max_tokens = 1400 } = body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return new Response(JSON.stringify({ error: 'Missing messages' }), {
      status: 400, headers: corsHeaders(origin)
    });
  }

   // Try a few models and gracefully fall back if JSON mode isn't supported
  const tryModels = [
    model,                 // whatever the client asked for
    'gpt-4o-mini',         // often supports JSON mode
    'gpt-4o',              // fast, broad support
    'gpt-4-turbo',         // backup
    'gpt-3.5-turbo'        // last-ditch
  ].filter(Boolean) as string[];

  let lastErr: any = null;

  for (const m of tryModels) {
    // Build base payload
    const payload: any = {
      model: m,
      temperature,
      max_tokens,
      messages
    };

    // Only attach JSON mode for models that typically support it
    if (/^(gpt-4o-mini|gpt-4\.1|o4-mini)/.test(m)) {
      payload.response_format = { type: 'json_object' };
    }

    let resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(payload)
    });

    if (resp.ok) {
      const data = await resp.text();
      return new Response(data, { status: 200, headers: corsHeaders(origin) });
    }

    // Peek at the error to decide if we should retry without JSON mode
    const detailText = await resp.text();
    const detail = (() => { try { return JSON.parse(detailText); } catch { return null; } })();

    const msg = String(detail?.error?.message || detailText || '');
    const type = String(detail?.error?.type || '');

    // If the failure is specifically about response_format, retry once without it
    if (payload.response_format && (msg.includes('response_format') || type === 'invalid_request_error')) {
      delete payload.response_format;
      resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        const data = await resp.text();
        return new Response(data, { status: 200, headers: corsHeaders(origin) });
      }
      lastErr = { status: resp.status, detail: await resp.text() };
      continue;
    }

    lastErr = { status: resp.status, detail: detail || detailText };
  }

  return new Response(JSON.stringify({ error: 'OpenAI error', detail: lastErr }), {
    status: 500, headers: corsHeaders(origin)
  });
