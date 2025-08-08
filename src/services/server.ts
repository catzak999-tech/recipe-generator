// src/services/server.ts
export async function callServer(messages: any[]) {
  const resp = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages,
      // harmless if backend already forces it, but keeps things in sync
      model: "gpt-4o-mini"
    })
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Server error ${resp.status}: ${detail}`);
  }
  return await resp.json();
}
