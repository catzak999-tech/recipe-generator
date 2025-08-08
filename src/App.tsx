import React, { useState } from "react";
import { callServer } from "./services/server";

export default function App() {
  const [status, setStatus] = useState<"idle"|"loading"|"ok"|"error">("idle");
  const [output, setOutput] = useState<string>("");

  async function runTest() {
    try {
      setStatus("loading");
      setOutput("");
      const messages = [
        { role: "system", content: "Reply with exactly this JSON: {\"ok\":true}" },
        { role: "user", content: "Only JSON. No extra text." }
      ];
      const data = await callServer(messages);
      const content = data?.choices?.[0]?.message?.content ?? JSON.stringify(data);
      setOutput(content);
      setStatus("ok");
    } catch (e:any) {
      setOutput(e?.message || String(e));
      setStatus("error");
    }
  }

  return (
    <div style={{padding:"24px", maxWidth: 800, margin: "40px auto", fontFamily: "ui-sans-serif, system-ui"}}>
      <h1 style={{fontSize: 28, marginBottom: 8}}>Recipe Generator</h1>
      <p style={{opacity:.8, marginBottom: 16}}>Backend smoke test.</p>

      <button
        onClick={runTest}
        style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #444",
                 background: "#2563eb", color: "white", cursor: "pointer" }}
      >
        Test server call
      </button>

      <div style={{marginTop: 16, padding: 12, background: "#111", color: "#ddd", borderRadius: 8, whiteSpace: "pre-wrap"}}>
        <strong>Status:</strong> {status}
        <div style={{marginTop: 8}}>
          <strong>Output:</strong>
          <div style={{marginTop: 6, fontFamily: "ui-monospace, Menlo, Consolas"}}>
            {output || "(no output yet)"}
          </div>
        </div>
      </div>
    </div>
  );
}
