import { supabaseAdmin } from './_shared/supabaseAdmin.js';
import { computeHealth } from './_shared/orderHealth.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Vercel Cron requests carry this header automatically; if you also set
  // CRON_SECRET in env vars, Vercel adds `Authorization: Bearer <secret>`
  // too — checked here so this endpoint can't be spammed by outsiders.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).send('Unauthorized');
    }
  }

  const admin = supabaseAdmin();

  const { data: orders, error } = await admin
    .from('orders')
    .select('id, order_status, fulfillment_status, tracking_status, last_tracking_update, created_at, health_status')
    .neq('order_status', 'cancelled')
    .limit(1000);

  if (error) {
    console.error('order-health-recompute: fetch failed', error);
    return res.status(500).send('error');
  }

  let changed = 0;
  for (const order of orders || []) {
    const health = computeHealth(order);
    if (health.status !== order.health_status) {
      await admin
        .from('orders')
        .update({ health_status: health.status, health_reason: health.reason, updated_at: new Date().toISOString() })
        .eq('id', order.id);
      changed++;
    }
  }

  console.log(`order-health-recompute: checked ${orders?.length || 0}, updated ${changed}`);
  return res.status(200).send('ok');
}
