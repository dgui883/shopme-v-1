import { supabaseAdmin, getAuthedProfile } from './_shared/supabaseAdmin.js';
import { json, safeError, checkRateLimit, recordRateLimitAttempt, readJsonBody } from './_shared/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const profile = await getAuthedProfile(req);
  if (!profile) return json(res, 401, { error: 'Please sign in first.' });
  if (profile.status !== 'active') {
    return json(res, 403, { error: 'Your account cannot perform this action right now.' });
  }

  const admin = supabaseAdmin();

  const rlKey = `license-activate:${profile.id}`;
  const allowed = await checkRateLimit(admin, { key: rlKey, maxAttempts: 5, windowSeconds: 600 });
  if (!allowed) {
    return json(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  await recordRateLimitAttempt(admin, rlKey);

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid request.' });
  }

  const code = String(body?.activation_code || '').trim().toUpperCase();
  if (!/^SHOPME-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    return json(res, 400, { error: "That activation code doesn't look right. Please check and try again." });
  }

  try {
    const { data: license, error: findErr } = await admin
      .from('licenses')
      .select('*')
      .eq('activation_code', code)
      .maybeSingle();

    if (findErr) throw findErr;
    if (!license) return json(res, 404, { error: 'Activation code not found.' });

    if (license.status === 'revoked') return json(res, 400, { error: 'This activation code has been revoked.' });
    if (license.status === 'suspended') return json(res, 400, { error: 'This activation code is suspended. Please contact support.' });
    if (license.status === 'active' && license.assigned_user_id) {
      return json(res, 400, { error: 'This activation code has already been used.' });
    }
    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return json(res, 400, { error: 'This activation code has expired.' });
    }

    const { data: updated, error: updateErr } = await admin
      .from('licenses')
      .update({ status: 'active', assigned_user_id: profile.id, activated_at: new Date().toISOString() })
      .eq('id', license.id)
      .eq('status', 'unused')
      .select()
      .maybeSingle();

    if (updateErr) throw updateErr;
    if (!updated) return json(res, 400, { error: 'This activation code has already been used.' });

    await admin.from('activities').insert({
      user_id: profile.id,
      activity_type: 'license_activated',
      description: `License ${code} activated`,
      metadata: { license_id: license.id },
    });

    return json(res, 200, { success: true, license: { code, status: 'active', activated_at: updated.activated_at } });
  } catch (err) {
    return safeError(res, 'Activation failed. Please try again.', err);
  }
}
