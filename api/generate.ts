// /api/generate.ts
export const config = { runtime: 'edge' };

const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const APP_TOKEN = process.env.APP_TOKEN || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');

function okCors(origin: string) {
  if (!ALLOW_ORIGINS.length) return true;
  return ALLOW_ORIGINS.includes(origin);
}
function corsHeaders(origin: string) {
  const h: Record<string,string> = { 'content-type': 'application/json' };
  if (!origin || okCors(origin)) {
    h['access-control-allow-origin'] = origin || '*';
    h['access-control-allow-headers'] = 'content-type,x-app-token';
    h['access-control-allow-methods'] = 'POST,OPTIONS';
  }
  return h;
}

export default async function handler(req: Request) {
  const origin = req.headers.get('origin') || '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // Block only if an Origin is present and not allowlisted
  if (origin && !okCors(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403, headers: corsHeaders(origin)
    });
  }

  // If it's not POST, say so (before token check so the URL shows a friendly message)
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: corsHeaders(origin)
    });
  }

  // App token check (only for POST)
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

  const { messages, model = 'gpt-4', temperature = 0.7, max_tokens = 1400 } = body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return new Response(JSON.stringify({ error: 'Missing messages' }), {
      status: 400, headers: corsHeaders(origin)
    });
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model, temperature, max_tokens, messages })
  });

  if (!resp.ok) {
    const err = await resp.text();
    return new Response(JSON.stringify({ error: 'OpenAI error', detail: err }), {
      status: resp.status, headers: corsHeaders(origin)
    });
  }

  const data = await resp.text();
  return new Response(data, { status: 200, headers: corsHeaders(origin) });
}
