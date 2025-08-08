import React, { useEffect, useMemo, useState } from "react";
import { callServer } from "./services/server";

/** ---------------- helpers ---------------- */
function sliceToJson(s: string) {
  if (!s) throw new Error("Empty model response");
  let t = s.trim();

  // Strip ```json fences if present
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Fast path
  try { JSON.parse(t); return t; } catch {}

  // Brace-aware scan (tolerates stray text)
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; continue; }
    if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const cand = t.slice(start, i + 1);
          try { JSON.parse(cand); return cand; } catch {}
        }
      }
    }
  }

  // If it started an object but never closed, try to close it
  if (start !== -1 && depth > 0) {
    const cand = t.slice(start) + "}".repeat(depth);
    try { JSON.parse(cand); return cand; } catch {}
  }

  console.debug("RAW MODEL RESPONSE:", s);
  throw new Error("No JSON object found");
}

function toArray<T>(x: any): T[] {
  return Array.isArray(x) ? x : x ? [x] : [];
}
function normalizeIngredients(list: any): { name: string; amount?: string; note?: string }[] {
  if (!list) return [];
  if (Array.isArray(list)) {
    return list.map((it: any) => {
      if (typeof it === "string") return { name: it };
      return {
        name: String(it.name ?? it.ingredient ?? ""),
        amount: it.amount ? String(it.amount) : undefined,
        note: it.note ? String(it.note) : undefined
      };
    }).filter(x => x.name);
  }
  if (typeof list === "object") {
    return Object.entries(list).map(([k, v]) => ({ name: k, amount: String(v ?? "") }));
  }
  return [];
}
function formatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

type Skill = "Beginner" | "Intermediate" | "Advanced";
type Units = "US" | "Metric";
type Theme = "dark" | "light";

export default function App() {
  /** ---------------- theme ---------------- */
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "dark");
  useEffect(() => {
    localStorage.setItem("theme", theme);
    document.documentElement.style.background = "";
    document.body.style.background = "";
  }, [theme]);

  const palette = theme === "dark"
    ? { text:"#e5e7eb", bg:"#0b1220", panel:"#0b1220", border:"#1f2937", input:"#111827", button:"#2563eb", danger:"#7f1d1d", dangerBorder:"#ef4444" }
    : { text:"#0b1220", bg:"#ffffff", panel:"#ffffff", border:"#d1d5db", input:"#ffffff", button:"#2563eb", danger:"#fee2e2", dangerBorder:"#ef4444" };

  /** ---------------- form state ---------------- */
  const [ingredients, setIngredients] = useState("");
  const [excludes, setExcludes] = useState("");
  const [cuisine, setCuisine] = useState("Mediterranean");
  const [timeLimit, setTimeLimit] = useState(30);
  const [skill, setSkill] = useState<Skill>("Beginner");
  const [units, setUnits] = useState<Units>("US");

  // new feature toggles
  const [smartSelect, setSmartSelect] = useState(true);   // “Choose best subset”
  const [strictMode, setStrictMode] = useState(false);    // “Forbid any ingredients not provided by you”

  /** ---------------- app state ---------------- */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [recipe, setRecipe] = useState<any>(null);

  /** ---------------- cook mode (timers) ---------------- */
  const [cookOn, setCookOn] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [totalStart, setTotalStart] = useState<number>(0);
  const [totalElapsed, setTotalElapsed] = useState<number>(0);
  const [stepStart, setStepStart] = useState<number>(0);
  const [stepElapsed, setStepElapsed] = useState<number>(0);

  useEffect(() => {
    if (!cookOn || !running) return;
    const id = setInterval(() => {
      const now = Date.now();
      setStepElapsed(now - stepStart);
      setTotalElapsed(now - totalStart);
    }, 200);
    return () => clearInterval(id);
  }, [cookOn, running, stepStart, totalStart]);

  function startCooking() {
    setCookOn(true);
    setStepIdx(0);
    const now = Date.now();
    setTotalStart(now);
    setStepStart(now);
    setTotalElapsed(0);
    setStepElapsed(0);
    setRunning(false); // user hits “Start Step” to run
  }
  function startPauseStep() {
    if (!running) {
      const now = Date.now();
      setStepStart(now - stepElapsed);
      setTotalStart(now - totalElapsed);
      setRunning(true);
    } else {
      setRunning(false);
    }
  }
  function nextStep() {
    setRunning(false);
    setStepElapsed(0);
    const next = Math.min(stepIdx + 1, (recipe?.steps?.length || 1) - 1);
    setStepIdx(next);
  }
  function prevStep() {
    setRunning(false);
    setStepElapsed(0);
    const prev = Math.max(stepIdx - 1, 0);
    setStepIdx(prev);
  }
  function finishCooking() {
    setRunning(false);
    setCookOn(false);
  }

  /** ---------------- prompting ---------------- */
  const systemPrompt = useMemo(() => {
    return `
STRICT MODE. Return JSON ONLY. No markdown, no text outside JSON.

GOAL: Generate the best possible recipe from the user's ingredients.

TIME CONSTRAINTS:
- "totalTime" must be realistic and <= the user's time limit.
- No steps that exceed the limit (e.g., don't say "marinate 2 hours" when limit is 15).
- If raw proteins cannot be safely cooked within the limit, OMIT them and explain why in "omittedIngredients". Prefer a no-cook dishType: "spice-blend", "dressing", "sauce", or "snack/salad" using ready-to-eat items only.
- Beginner requires explicit safety; never imply undercooked meat.

SMART SELECTION:
- If smart selection is ON, pick a coherent subset ("selectedIngredients") and say why each was chosen.
- If smart selection is OFF, you MUST use all provided ingredients and none others.

STRICT MODE:
- If strict mode is ON, you may NOT use any ingredient that the user did not provide. No pantry items allowed unless explicitly listed by user.
- If strict mode is OFF, you may add minimal pantry items (e.g., salt, pepper, oil, water) but keep them few.

MEASUREMENTS:
- Provide both "ingredientsUS" and "ingredientsMetric" as ARRAYS of objects:
  [{ "name": "paprika", "amount": "1 tsp", "note": "" }]
- Do NOT return dictionaries/maps for ingredients.

SCORING:
- Give tasteScore, simplicityScore, overallScore (out of 10, one decimal).

SCHEMA (return exactly these keys):
{
  "title": string,
  "summary": string,
  "dishType": "main" | "side" | "snack/salad" | "dressing" | "sauce" | "spice-blend",
  "servings": number,
  "cuisine": string,
  "prepTime": string,
  "cookTime": string,
  "totalTime": string,
  "tasteScore": number,
  "simplicityScore": number,
  "overallScore": number,
  "selectedIngredients": [{ "name": string, "reason": string }],
  "omittedIngredients": [{ "name": string, "reason": string }],
  "ingredientsUS": [{ "name": string, "amount": string, "note"?: string }],
  "ingredientsMetric": [{ "name": string, "amount": string, "note"?: string }],
  "steps": [{ "step": number, "instruction": string, "time"?: string, "heat"?: string, "donenessCue"?: string, "tip"?: string }],
  "tips": [string],
  "substitutions": [{ "from": string, "to": string, "note"?: string }],
  "notes": [string]
}
Ensure arrays are arrays. Ensure totalTime <= limit.
`.trim();
  }, []);

  async function generate() {
    setError("");
    setRecipe(null);
    if (!ingredients.trim()) {
      setError("Give me some ingredients first.");
      return;
    }
    setLoading(true);
    try {
      const userPrompt = `
User ingredients: ${ingredients}
Exclude (optional): ${excludes || "(none)"}
Cuisine: ${cuisine}
Time limit: ${timeLimit} minutes
Skill level: ${skill}
Units: ${units}

Feature Flags:
- Smart selection: ${smartSelect ? "ON" : "OFF"}
- Strict mode: ${strictMode ? "ON" : "OFF"}

Rules:
- If Smart selection is OFF, you MUST use all provided ingredients and none others.
- If Strict mode is ON, you MUST NOT add any unlisted ingredients.
- JSON only, match the schema exactly.
`.trim();

      const data = await callServer([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]);

      const raw = String(data?.choices?.[0]?.message?.content ?? "");
      console.debug("RAW FROM MODEL →", raw);
      const json = JSON.parse(sliceToJson(raw));

      // normalize for rendering
      const normalized = {
        title: json.title || "Untitled",
        summary: json.summary || "",
        dishType: json.dishType || "main",
        servings: Number(json.servings ?? 2),
        cuisine: json.cuisine || cuisine,
        prepTime: json.prepTime || "",
        cookTime: json.cookTime || "",
        totalTime: json.totalTime || "",
        tasteScore: Number(json.tasteScore ?? 0),
        simplicityScore: Number(json.simplicityScore ?? 0),
        overallScore: Number(json.overallScore ?? 0),
        selectedIngredients: toArray(json.selectedIngredients).map((x: any) => ({
          name: String(x?.name ?? ""),
          reason: String(x?.reason ?? "")
        })).filter((x:any)=>x.name),
        omittedIngredients: toArray(json.omittedIngredients).map((x: any) => ({
          name: String(x?.name ?? ""),
          reason: String(x?.reason ?? "")
        })).filter((x:any)=>x.name),
        ingredientsUS: normalizeIngredients(json.ingredientsUS),
        ingredientsMetric: normalizeIngredients(json.ingredientsMetric),
        steps: toArray(json.steps).map((s:any,i:number)=>({
          step: Number(s?.step ?? i+1),
          instruction: String(s?.instruction ?? ""),
          time: s?.time ? String(s.time) : undefined,
          heat: s?.heat ? String(s.heat) : undefined,
          donenessCue: s?.donenessCue ? String(s.donenessCue) : undefined,
          tip: s?.tip ? String(s.tip) : undefined
        })).filter((s:any)=>s.instruction),
        tips: toArray<string>(json.tips).map(String),
        substitutions: toArray(json.substitutions).map((x:any)=>({from:String(x?.from??""), to:String(x?.to??""), note: x?.note?String(x.note):undefined})).filter((x:any)=>x.from && x.to),
        notes: toArray<string>(json.notes).map(String)
      };

      setRecipe(normalized);
      setCookOn(false);
    } catch (e: any) {
      console.warn("Primary parse failed:", e);
      setError(e?.message || "Failed to generate. Try again.");
    } finally {
      setLoading(false);
    }
  }

  /** ---------------- UI ---------------- */
  return (
    <div style={{ padding: 24, maxWidth: 980, margin: "32px auto", color: palette.text, fontFamily: "ui-sans-serif, system-ui", background: palette.bg }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 32, margin: 0 }}>Smart Recipe Generator</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.panel, color: palette.text, cursor: "pointer" }}
          >
            {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
          </button>
        </div>
      </div>
      <p style={{ opacity: 0.75, marginTop: 0, marginBottom: 16 }}>AI-powered recipe creation that chooses the best ingredients for perfect dishes. Requests are protected by a server key.</p>

      {/* form */}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <div style={{ gridColumn: "1 / span 2" }}>
          <label>Your Ingredients</label>
          <textarea
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
            placeholder="chicken breast, spinach, garlic, rice, onion, olive oil..."
            rows={3}
            style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text }}
          />
        </div>

        <div>
          <label>Exclude Ingredients (Optional)</label>
          <input
            value={excludes}
            onChange={(e) => setExcludes(e.target.value)}
            placeholder="dairy, cilantro..."
            style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text }}
          />
        </div>

        <div>
          <label>Cuisine</label>
          <input
            value={cuisine}
            onChange={(e) => setCuisine(e.target.value)}
            placeholder="Mediterranean"
            style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text }}
          />
        </div>

        <div>
          <label>Time limit (minutes)</label>
          <input
            type="number"
            min={5}
            value={timeLimit}
            onChange={(e) => setTimeLimit(parseInt(e.target.value || "0", 10))}
            style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text }}
          />
        </div>

        <div>
          <label>Skill</label>
          <select
            value={skill}
            onChange={(e) => setSkill(e.target.value as Skill)}
            style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text }}
          >
            <option>Beginner</option>
            <option>Intermediate</option>
            <option>Advanced</option>
          </select>
        </div>

        {/* feature toggles */}
        <div style={{ gridColumn: "1 / span 2", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <label>
            <input type="checkbox" checked={smartSelect} onChange={(e)=>setSmartSelect(e.target.checked)} />{" "}
            <strong>Smart Select Ingredients</strong> <span style={{ opacity: .75 }}>— choose best subset for flavor harmony</span>
          </label>
          <label>
            <input type="checkbox" checked={strictMode} onChange={(e)=>setStrictMode(e.target.checked)} />{" "}
            <strong>Strict Mode</strong> <span style={{ opacity: .75 }}>— forbid any ingredients not provided by you</span>
          </label>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
            <button
              onClick={generate}
              disabled={loading}
              style={{ padding: "12px 16px", borderRadius: 8, border: `1px solid ${palette.button}`, background: palette.button, color: "white", cursor: "pointer" }}
            >
              {loading ? "Generating..." : "Generate Recipe"}
            </button>
            <div>
              <label style={{ marginRight: 8 }}>Units:</label>
              <select
                value={units}
                onChange={(e) => setUnits(e.target.value as Units)}
                style={{ padding: 8, borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text }}
              >
                <option>US</option>
                <option>Metric</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: 12, background: palette.danger, border: `1px solid ${palette.dangerBorder}`, borderRadius: 8, color: theme === "dark" ? "#fff" : "#7f1d1d" }}>
          {error}
        </div>
      )}

      {/* recipe display */}
      {recipe && (
        <div style={{ marginTop: 24, padding: 18, borderRadius: 12, background: palette.panel, border: `1px solid ${palette.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ fontSize: 20, margin: 0 }}>{recipe.title}</h2>
            <div style={{ opacity: 0.8, fontSize: 14 }}>
              {recipe.servings} servings • {recipe.totalTime} • {recipe.cuisine}
            </div>
          </div>
          <p style={{ opacity: 0.8, marginTop: 6 }}>{recipe.summary}</p>

          {/* badges */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Badge label={`Taste ${recipe.tasteScore}/10`} />
            <Badge label={`Simplicity ${recipe.simplicityScore}/10`} />
            <Badge label={`Overall ${recipe.overallScore}/10`} />
            <Badge label={`Dish: ${recipe.dishType}`} />
          </div>

          {/* cook mode controls */}
          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={startCooking} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text, cursor: "pointer" }}>
              🍳 Start Cooking
            </button>
            {cookOn && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong>Step {stepIdx + 1}/{recipe.steps.length}</strong>
                <span>• Step: {formatMs(stepElapsed)} • Total: {formatMs(totalElapsed)}</span>
                <button onClick={startPauseStep} style={{ padding: "6px 10px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text, cursor: "pointer" }}>
                  {running ? "Pause" : "Start Step"}
                </button>
                <button onClick={prevStep} style={{ padding: "6px 10px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text, cursor: "pointer" }}>
                  ◀︎ Prev
                </button>
                <button onClick={nextStep} style={{ padding: "6px 10px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text, cursor: "pointer" }}>
                  Next ▶︎
                </button>
                <button onClick={finishCooking} style={{ padding: "6px 10px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.input, color: palette.text, cursor: "pointer" }}>
                  ✅ Finish
                </button>
              </div>
            )}
          </div>

          {/* show current step in cook mode */}
          {cookOn && recipe.steps?.[stepIdx] && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 8, border: `1px dashed ${palette.border}` }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Current Step</div>
              <div>{recipe.steps[stepIdx].instruction}</div>
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                {recipe.steps[stepIdx].time ? `⏱ ${recipe.steps[stepIdx].time} ` : ""}{recipe.steps[stepIdx].heat ? ` • 🔥 ${recipe.steps[stepIdx].heat}` : ""}{recipe.steps[stepIdx].donenessCue ? ` • ✅ ${recipe.steps[stepIdx].donenessCue}` : ""}
              </div>
              {recipe.steps[stepIdx].tip ? <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>Tip: {recipe.steps[stepIdx].tip}</div> : null}
            </div>
          )}

          <Section title="Selected Ingredients">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {recipe.selectedIngredients.map((x: any, i: number) => (
                <li key={i}><strong>{x.name}</strong> — <span style={{ opacity: 0.8 }}>{x.reason}</span></li>
              ))}
            </ul>
          </Section>

          {recipe.omittedIngredients.length > 0 && (
            <Section title="Omitted Ingredients">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {recipe.omittedIngredients.map((x: any, i: number) => (
                  <li key={i}><strong>{x.name}</strong> — <span style={{ opacity: 0.8 }}>{x.reason}</span></li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={`Ingredients (${units})`}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(units === "US" ? recipe.ingredientsUS : recipe.ingredientsMetric).map((it: any, i: number) => (
                <li key={i}>
                  <strong>{it.name}</strong>
                  {it.amount ? ` — ${it.amount}` : ""}
                  {it.note ? ` (${it.note})` : ""}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Steps">
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {recipe.steps.map((s: any, i: number) => (
                <li key={i} style={{ marginBottom: 8 }}>
                  <div>{s.instruction}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {s.time ? `⏱ ${s.time} ` : ""}{s.heat ? ` • 🔥 ${s.heat}` : ""}{s.donenessCue ? ` • ✅ ${s.donenessCue}` : ""}
                  </div>
                  {s.tip ? <div style={{ fontSize: 12, opacity: 0.8 }}>Tip: {s.tip}</div> : null}
                </li>
              ))}
            </ol>
          </Section>

          {recipe.tips?.length > 0 && (
            <Section title="Pro Tips">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {recipe.tips.map((t: string, i: number) => <li key={i}>{t}</li>)}
              </ul>
            </Section>
          )}

          {recipe.substitutions?.length > 0 && (
            <Section title="Substitutions">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {recipe.substitutions.map((s: any, i: number) => (
                  <li key={i}><strong>{s.from}</strong> → <strong>{s.to}</strong>{s.note ? ` — ${s.note}` : ""}</li>
                ))}
              </ul>
            </Section>
          )}

          {recipe.notes?.length > 0 && (
            <Section title="Notes">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {recipe.notes.map((t: string, i: number) => <li key={i}>{t}</li>)}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

/** ---------- tiny UI bits ---------- */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 18, marginBottom: 6 }}>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
function Badge({ label }: { label: string }) {
  return (
    <span style={{ fontSize: 12, border: "1px solid #374151", padding: "4px 8px", borderRadius: 999 }}>
      {label}
    </span>
  );
}
