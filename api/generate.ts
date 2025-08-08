// /api/generate.ts
export const config = { runtime: 'edge' };

const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const APP_TOKEN = process.env.APP_TOKEN || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');

function okCors(origin: string) {
  if (!ALLOW_ORIGINS.length) return true;
  return ALLOW_ORIGINS.includes(origin);
}
function corsHeaders(origin: string) {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (!origin || okCors(origin)) {
    h['access-control-allow-origin'] = origin || '*';
    h['access-control-allow-headers'] = 'content-type,x-app-token';
    h['access-control-allow-methods'] = 'POST,OPTIONS';
  }
  return h;
}

export default async function handler(req: Request) {
  const origin = req.headers.get('origin') || '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (origin && !okCors(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: corsHeaders(origin)
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: corsHeaders(origin)
    });
  }
  if (APP_TOKEN) {
    const token = req.headers.get('x-app-token') || '';
    if (token !== APP_TOKEN) {
      return new Response(JSON.stringify({ error: 'Invalid app token' }), {
        status: 401,
        headers: corsHeaders(origin)
      });
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: corsHeaders(origin)
    });
  }

  const {
    messages,
    model = 'gpt-4o-mini',
    temperature = 0.4,
    max_tokens = 2000
  } = body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return new Response(JSON.stringify({ error: 'Missing messages' }), {
      status: 400,
      headers: corsHeaders(origin)
    });
  }

  // Function schema that matches your UI’s expectation
  const recipeTool = {
    type: 'function',
    function: {
      name: 'return_recipe',
      description: 'Return the final recipe JSON that the UI will render.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          dishType: {
            type: 'string',
            enum: ['main', 'side', 'snack/salad', 'dressing', 'sauce', 'spice-blend']
          },
          servings: { type: 'number' },
          cuisine: { type: 'string' },
          prepTime: { type: 'string' },
          cookTime: { type: 'string' },
          totalTime: { type: 'string' },
          tasteScore: { type: 'number' },
          simplicityScore: { type: 'number' },
          overallScore: { type: 'number' },
          selectedIngredients: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                reason: { type: 'string' }
              },
              required: ['name', 'reason']
            }
          },
          omittedIngredients: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                reason: { type: 'string' }
              },
              required: ['name', 'reason']
            }
          },
          ingredientsUS: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                amount: { type: 'string' },
                note: { type: 'string' }
              },
              required: ['name']
            }
          },
          ingredientsMetric: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                amount: { type: 'string' },
                note: { type: 'string' }
              },
              required: ['name']
            }
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'number' },
                instruction: { type: 'string' },
                time: { type: 'string' },
                heat: { type: 'string' },
                donenessCue: { type: 'string' },
                tip: { type: 'string' }
              },
              required: ['step', 'instruction']
            }
          },
          tips: { type: 'array', items: { type: 'string' } },
          substitutions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                note: { type: 'string' }
              },
              required: ['from', 'to']
            }
          },
          notes: { type: 'array', items: { type: 'string' } }
        },
        required: [
          'title',
          'summary',
          'dishType',
          'servings',
          'cuisine',
          'prepTime',
          'cookTime',
          'totalTime',
          'tasteScore',
          'simplicityScore',
          'overallScore',
          'selectedIngredients',
          'omittedIngredients',
          'ingredientsUS',
          'ingredientsMetric',
          'steps',
          'tips',
          'substitutions',
          'notes'
        ]
      }
    }
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens,
      messages,
      tools: [recipeTool],
      tool_choice: { type: 'function', function: { name: 'return_recipe' } }
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    return new Response(JSON.stringify({ error: 'OpenAI error', detail: err }), {
      status: resp.status,
      headers: corsHeaders(origin)
    });
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  let content = choice?.message?.content ?? '';

  // If the model used the function, grab the JSON arguments
  const toolArgs = choice?.message?.tool_calls?.[0]?.function?.arguments;
  if (toolArgs) {
    content = toolArgs; // stringified JSON per the schema
  }

  // Return the same shape the frontend already expects
  const shim = { choices: [{ message: { content } }] };
  return new Response(JSON.stringify(shim), {
    status: 200,
    headers: corsHeaders(origin)
  });
}
