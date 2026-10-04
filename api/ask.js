// Vercel serverless function: POST /api/ask
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   GEMINI_API_KEY     FREE option: key from aistudio.google.com/apikey  (used if set)
//   ANTHROPIC_API_KEY  paid option: key from console.anthropic.com       (used if no Gemini key)
//   ACCESS_CODE        (required) a password only you know; the page asks for it once
//   MODEL              (optional) defaults: gemini-3.5-flash-lite  /  claude-sonnet-5-5
//
// Two modes:
//   (default)      tutor chat about one question
//   mode:'pick'    AI test builder: receives {request, catalog}, returns {picks:[indices], summary, mins}
const SYSTEM = `You are a sharp, practical CAT (Common Admission Test, India) tutor for VARC, DILR and Quant.
You are given one question the student attempted, the correct answer, the student's response, and sometimes a book explanation.
Rules: be concise and concrete. For RC questions, point to the specific part of the passage and name the trap in the wrong options (extreme, out of scope, opposite, half-right). If the student was wrong or skipped, say where their reasoning likely went off and what to do differently next time. If the book explanation seems wrong or incomplete, say so plainly. Plain text, short paragraphs, no headings.`;

const PICK_SYSTEM = `You help a CAT (India) aspirant build a practice test from their own question bank.
You get a REQUEST and a CATALOG. Each catalog line looks like: index|section|type|[setN]|question text. Sections: QA = Quant, VARC = verbal/RC, DILR = data interpretation & logical reasoning. Lines sharing the same setN belong to one passage/data set; the first line of a set also shows the start of the passage.
Choose the questions that best match the request, using ONLY indices that appear in the catalog.
- Judge the topic from the question text. Arithmetic means things like percentages, profit & loss, ratio & proportion, averages, mixtures, time-speed-distance, time & work, simple/compound interest. Algebra, geometry, number system and modern maths are separate topics.
- Respect any section, type (MCQ/TITA), difficulty or count in the request. If no count is given, pick 10. Never pick more than 60.
- For passage/data sets, pick every question of the set together if you pick any (unless the request clearly asks for single questions).
- If fewer questions match than requested, return only the genuine matches. Do not pad with unrelated questions. Skip image-only questions whose topic you cannot tell.
Reply with ONLY a JSON object, no markdown fences:
{"picks":[indices],"summary":"1-2 sentences on what you picked and any shortfall","mins":null}
Set "mins" to a number only if the request specifies a time limit in minutes, otherwise null.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code, context, messages, mode, request, catalog } = req.body || {};
  const GKEY = process.env.GEMINI_API_KEY, AKEY = process.env.ANTHROPIC_API_KEY;
  if ((!GKEY && !AKEY) || !process.env.ACCESS_CODE)
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY (or ANTHROPIC_API_KEY) or ACCESS_CODE' });
  if (code !== process.env.ACCESS_CODE) return res.status(401).json({ error: 'Wrong access code' });

  const pick = mode === 'pick';
  let system, clean;
  if (pick) {
    if (typeof request !== 'string' || !request.trim() || typeof catalog !== 'string' || !catalog.trim())
      return res.status(400).json({ error: 'Bad request' });
    system = PICK_SYSTEM;
    clean = [{ role: 'user', content: 'REQUEST: ' + request.slice(0, 500) + '\n\nCATALOG:\n' + catalog.slice(0, 150000) }];
  } else {
    if (!Array.isArray(messages) || !messages.length || messages[0].role !== 'user')
      return res.status(400).json({ error: 'Bad messages' });
    clean = messages.slice(-12).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 4000)
    }));
    while (clean.length && clean[0].role !== 'user') clean.shift();
    if (!clean.length || clean[clean.length - 1].role !== 'user') return res.status(400).json({ error: 'Bad messages' });
    system = SYSTEM + '\n\nQUESTION CONTEXT:\n' + String(context || '').slice(0, 14000);
  }

  try {
    let r, d, text;
    if (GKEY) {
      const model = process.env.MODEL || 'gemini-3.5-flash-lite';
      const generationConfig = pick
        ? { maxOutputTokens: 6000, responseMimeType: 'application/json' }
        : { maxOutputTokens: 1500 };
      r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: clean.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig
        })
      });
      d = await r.json();
      if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'Free-tier limit reached — wait a minute and try again.' : ((d.error && d.error.message) || 'AI provider error') });
      const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
      text = parts.map(p => p.text || '').join('\n').trim();
      if (!text) return res.status(502).json({ error: 'The AI returned an empty reply (it may have been blocked). Try rephrasing.' });
    } else {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': AKEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.MODEL || 'claude-sonnet-5-5', max_tokens: pick ? 3000 : 1200, system, messages: clean })
      });
      d = await r.json();
      if (!r.ok) return res.status(502).json({ error: (d.error && d.error.message) || 'AI provider error' });
      text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    }

    if (pick) {
      let o;
      try { o = JSON.parse(text); }
      catch (e) {
        const m = text.match(/\{[\s\S]*\}/);
        try { o = JSON.parse(m && m[0]); }
        catch (e2) { return res.status(502).json({ error: 'The AI gave an unreadable reply. Please try again.' }); }
      }
      const picks = (Array.isArray(o.picks) ? o.picks : []).map(Number).filter(Number.isInteger);
      const mins = Number(o.mins) > 0 ? Number(o.mins) : null;
      return res.status(200).json({ picks, summary: String(o.summary || '').slice(0, 500), mins });
    }
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the AI provider' });
  }
};
