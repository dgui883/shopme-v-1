export function json(res, statusCode, body) {
  res.status(statusCode).json(body);
}

export function safeError(res, publicMessage, err) {
  console.error(publicMessage, err);
  res.status(500).json({ error: publicMessage });
}

// Reads and parses a JSON body regardless of whether Vercel's automatic
// bodyParser already ran (req.body is set) or was disabled (raw stream).
export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// Best-effort rate limiting using the Supabase DB as the shared store.
export async function checkRateLimit(admin, { key, maxAttempts, windowSeconds }) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count } = await admin
    .from('activities')
    .select('id', { count: 'exact', head: true })
    .eq('activity_type', `ratelimit:${key.split(':')[0]}`)
    .eq('description', key)
    .gte('created_at', since);

  return (count || 0) < maxAttempts;
}

export async function recordRateLimitAttempt(admin, key) {
  await admin.from('activities').insert({
    activity_type: `ratelimit:${key.split(':')[0]}`,
    description: key,
    metadata: {},
  });
}
