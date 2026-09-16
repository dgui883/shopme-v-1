import { getAuthedProfile, supabaseAdmin } from './_shared/supabaseAdmin.js';
import { json, safeError, readJsonBody } from './_shared/http.js';
import { signState } from './_shared/crypto.js';

const SCOPES = 'read_orders,read_products,read_customers,read_fulfillments';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const profile = await getAuthedProfile(req);
  if (!profile) return json(res, 401, { error: 'Please sign in first.' });
  if (profile.status !== 'active') return json(res, 403, { error: 'Your account cannot perform this action right now.' });

  const admin = supabaseAdmin();
  const { data: license } = await admin
    .from('licenses')
    .select('id,status')
    .eq('assigned_user_id', profile.id)
    .eq('status', 'active')
    .maybeSingle();
  if (!license) return json(res, 403, { error: 'Please activate your license before connecting Shopify.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid request.' });
  }

  const shopDomain = String(body?.shop_domain || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return json(res, 400, { error: 'Please enter a valid myshopify.com store domain.' });
  }

  try {
    const state = signState({ user_id: profile.id, shop_domain: shopDomain });
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const appUrl = process.env.SHOPIFY_APP_URL;
    const redirectUri = `${appUrl}/api/shopify-oauth-callback`;

    const authorizeUrl =
      `https://${shopDomain}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return json(res, 200, { authorize_url: authorizeUrl });
  } catch (err) {
    return safeError(res, 'Could not start the Shopify connection. Please try again.', err);
  }
}
