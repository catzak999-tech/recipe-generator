// src/services/server.ts
export async function callServer(messages: any[]) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const appToken = import.meta.env.VITE_APP_TOKEN;   // <-- read token (Vite build-time)
  if (appToken) headers["x-app-token"] = appToken;   // <-- send header if present

  const resp = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 1400,
      messages,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error || "Server error");
  return data;
}
