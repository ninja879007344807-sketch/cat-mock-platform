// Vercel serverless function: POST /api/ask
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   GEMINI_API_KEY     FREE option: key from aistudio.google.com/apikey  (used if set)
//   ANTHROPIC_API_KEY  paid option: key from console.anthropic.com       (used if no Gemini key)
//   ACCESS_CODE        (required) a password only you know; the page asks for it once
//   MODEL              (optional) defaults: gemini-2.5-flash-lite  /  claude-sonnet-5-5
const SYSTEM = `You are a sharp, practical CAT (Common Admission Test, India) tutor for VARC, DILR and Quant.
You are given one question the student attempted, the correct answer, the student's response, and sometimes a book explanation.
Rules: be concise and concrete. For RC questions, point to the specific part of the passage and name the trap in the wrong options (extreme, out of scope, opposite, half-right). If the student was wrong or skipped, say where their reasoning likely went off and what to do differently next time. If the book explanation seems wrong or incomplete, say so plainly. Plain text, short paragraphs, no headings.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code, context, messages } = req.body || {};
  const GKEY = process.env.GEMINI_API_KEY, AKEY = process.env.ANTHROPIC_API_KEY;
  if ((!GKEY && !AKEY) || !process.env.ACCESS_CODE)
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY (or ANTHROPIC_API_KEY) or ACCESS_CODE' });
  if (code !== process.env.ACCESS_CODE) return res.status(401).json({ error: 'Wrong access code' });
  if (!Array.isArray(messages) || !messages.length || messages[0].role !== 'user')
    return res.status(400).json({ error: 'Bad messages' });
  const clean = messages.slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 4000)
  }));
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== 'user') return res.status(400).json({ error: 'Bad messages' });
  const system = SYSTEM + '\n\nQUESTION CONTEXT:\n' + String(context || '').slice(0, 14000);
  try {
    let r, d, text;
    if (GKEY) {
      const model = process.env.MODEL || 'gemini-2.5-flash-lite';
      r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: clean.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 1500 }
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
        body: JSON.stringify({ model: process.env.MODEL || 'claude-sonnet-5-5', max_tokens: 1200, system, messages: clean })
      });
      d = await r.json();
      if (!r.ok) return res.status(502).json({ error: (d.error && d.error.message) || 'AI provider error' });
      text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the AI provider' });
  }
};
