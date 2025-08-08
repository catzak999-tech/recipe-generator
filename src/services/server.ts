const BASE = ''; // same-origin in production

export async function callServer(messages: any[]) {
  const token = import.meta.env.VITE_PUBLIC_APP_TOKEN || '';
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-app-token': token } : {})
    },
    body: JSON.stringify({
      model: 'gpt-4',
      temperature: 0.2,
      max_tokens: 120,
      messages
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(()=> '');
    throw new Error(`Server error ${res.status}: ${detail}`);
  }
  return res.json();
}
