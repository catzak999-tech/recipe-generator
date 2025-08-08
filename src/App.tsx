import React, { useMemo, useState } from "react";
import { callServer } from "./services/server";

/** ---------- tiny helpers ---------- */
function sliceToJson(s: string) {
  if (!s) throw new Error("Empty model response");
  let t = s.trim();

  // Strip code fences if present
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  }

  // Try direct object parse
  try {
    const maybe = JSON.parse(t);
    if (maybe && typeof maybe === "object" && !Array.isArray(maybe)) return t;
  } catch {}

  // Try to grab the outermost {...}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = t.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  // Last resort: show the raw text so we can debug fast
  console.debug("RAW MODEL RESPONSE:", s);
  throw new Error("No JSON object found");
}

function toArray<T>(x: any): T[] {
  return Array.isArray(x) ? x : x ? [x] : [];
}

function normalizeIngredients(list: any): { name: string; amount?: string; note?: string }[] {
  if (!list) return [];
  if (Array.isArray(list)) {
    return list
      .map((it: any) => {
        if (typeof it === "string") return { name: it };
        return {
          name: String(it.name ?? it.ingredient ?? ""),
          amount: it.amount ? String(it.amount) : undefined,
          note: it.note ? String(it.note) : undefined
        };
      })
      .filter(x => x.name);
  }
  // object map fallback { "paprika": "1 tsp" }
  if (typeof list === "object") {
    return Object.entries(list).map(([k, v]) => ({ name: k, amount: String(v ?? "") }));
  }
  return [];
}

type Skill = "Beginner" | "Intermediate" | "Advanced";
type Units = "US" | "Metric";

export default function App() {
  const [ingredients, setIngredients] = useState("");
  const [excludes, setExcludes] = useState("");
  const [cuisine, setCuisine] = useState("Mediterranean");
  const [timeLimit, setTimeLimit] = useState(30);
  const [skill, setSkill] = useState<Skill>("Beginner");
  const [units, setUnits] = useState<Units>("US");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [recipe, setRecipe] = useState<any>(null);

  const systemPrompt = useMemo(() => {
    return `
STRICT MODE. Return JSON ONLY. No markdown, no text outside JSON.

GOAL: Generate the best possible recipe from the user's ingredients. DO NOT use all ingredients by default; select the subset that tastes best for the chosen cuisine.

TIME CONSTRAINTS:
- The recipe "totalTime" must be realistic and <= the user's time limit.
- No steps that exceed the limit (e.g., don't say "marinate 2 hours" when limit is 15).
- If raw proteins cannot be safely cooked within the limit, OMIT them and explain why in "omittedIngredients". Choose a no-cook dishType: "spice-blend", "dressing", "sauce", or "snack/salad" using ready-to-eat items only.
- Beginner requires explicit safety; never imply undercooked meat.

SMART SELECTION:
- Pick a coherent subset ("selectedIngredients") and say why each was chosen.
- Put the rest in "omittedIngredients" with a short reason.

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

Constraints:
- Choose a subset that tastes best; don't force all items.
- Respect exclusions.
- Respect time strictly.
- JSON only, match the schema.
`.trim();

      const data = await callServer([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]);
const raw = String(data?.choices?.[0]?.message?.content ?? "");
console.debug("RAW FROM MODEL →", raw);
const json = JSON.parse(sliceToJson(raw));



      // normalize shape for rendering
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
    } catch (e: any) {
      setError(e?.message || "Failed to generate. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: "24px", maxWidth: 980, margin: "32px auto", color: "#e5e7eb", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>Recipe Generator</h1>
      <p style={{ opacity: 0.75, marginBottom: 16 }}>Give me your ingredients. I’ll pick the best combo that fits your time and skill.</p>

      {/* form */}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <div style={{ gridColumn: "1 / span 2" }}>
          <label>Ingredients you have (comma separated)</label>
          <textarea
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
            placeholder="chicken thighs, lemon, garlic, rice, honey..."
            rows={3}
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#fff" }}
          />
        </div>

        <div>
          <label>Exclude (optional)</label>
          <input
            value={excludes}
            onChange={(e) => setExcludes(e.target.value)}
            placeholder="dairy, cilantro..."
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#fff" }}
          />
        </div>

        <div>
          <label>Cuisine</label>
          <input
            value={cuisine}
            onChange={(e) => setCuisine(e.target.value)}
            placeholder="Mediterranean"
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#fff" }}
          />
        </div>

        <div>
          <label>Time limit (minutes)</label>
          <input
            type="number"
            min={5}
            value={timeLimit}
            onChange={(e) => setTimeLimit(parseInt(e.target.value || "0", 10))}
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#fff" }}
          />
        </div>

        <div>
          <label>Skill</label>
          <select
            value={skill}
            onChange={(e) => setSkill(e.target.value as Skill)}
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#fff" }}
          >
            <option>Beginner</option>
            <option>Intermediate</option>
            <option>Advanced</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <button
            onClick={generate}
            disabled={loading}
            style={{ padding: "12px 16px", borderRadius: 8, border: "1px solid #2563eb", background: "#2563eb", color: "white", cursor: "pointer" }}
          >
            {loading ? "Generating..." : "Generate Recipe"}
          </button>
          <div style={{ marginLeft: 12 }}>
            <label style={{ marginRight: 8 }}>Units:</label>
            <select
              value={units}
              onChange={(e) => setUnits(e.target.value as Units)}
              style={{ padding: 8, borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#fff" }}
            >
              <option>US</option>
              <option>Metric</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: 12, background: "#7f1d1d", border: "1px solid #ef4444", borderRadius: 8 }}>
          {error}
        </div>
      )}

      {/* recipe display */}
      {recipe && (
        <div style={{ marginTop: 24, padding: 18, borderRadius: 12, background: "#0b1220", border: "1px solid #1f2937" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ fontSize: 24 }}>{recipe.title}</h2>
            <div style={{ opacity: 0.8, fontSize: 14 }}>
              {recipe.servings} servings • {recipe.totalTime} • {recipe.cuisine}
            </div>
          </div>
          <p style={{ opacity: 0.8, marginTop: 6 }}>{recipe.summary}</p>

          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <Badge label={`Taste ${recipe.tasteScore}/10`} />
            <Badge label={`Simplicity ${recipe.simplicityScore}/10`} />
            <Badge label={`Overall ${recipe.overallScore}/10`} />
            <Badge label={`Dish: ${recipe.dishType}`} />
          </div>

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
    <span style={{ fontSize: 12, border: "1px solid #374151", padding: "4px 8px", borderRadius: 999, background: "#0b1220" }}>
      {label}
    </span>
  );
}
