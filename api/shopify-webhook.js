import { supabaseAdmin } from './_shared/supabaseAdmin.js';
import { verifyShopifyWebhook } from './_shared/crypto.js';
import { computeHealth } from './_shared/orderHealth.js';

// Disable Vercel's automatic JSON body parsing — we need the exact raw
// bytes Shopify sent to verify the HMAC signature. A re-serialized JSON
// body is not guaranteed to match byte-for-byte.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  const rawBody = await readRawBody(req);
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const topic = req.headers['x-shopify-topic'];
  const shopDomain = (req.headers['x-shopify-shop-domain'] || '').toLowerCase();
  const webhookId = req.headers['x-shopify-webhook-id'];

  if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
    return res.status(401).send('Invalid signature');
  }
  if (!shopDomain || !topic) {
    return res.status(400).send('Missing required headers');
  }

  const admin = supabaseAdmin();

  if (webhookId) {
    const { error: dupErr } = await admin
      .from('webhook_events')
      .insert({ shopify_webhook_id: webhookId, topic, shop_domain: shopDomain });
    if (dupErr) return res.status(200).send('Already processed');
  }

  const { data: store } = await admin
    .from('shopify_stores')
    .select('id,user_id,connection_status')
    .eq('shop_domain', shopDomain)
    .maybeSingle();

  if (!store) return res.status(200).send('Unknown store, ignored');

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  try {
    if (topic === 'app/uninstalled') {
      await admin.from('shopify_stores').update({ connection_status: 'disconnected', updated_at: new Date().toISOString() }).eq('id', store.id);
      await admin.from('shopify_connections').update({ revoked_at: new Date().toISOString() }).eq('shopify_store_id', store.id);
      await admin.from('activities').insert({
        user_id: store.user_id,
        shopify_store_id: store.id,
        activity_type: 'shopify_disconnected',
        description: 'Merchant uninstalled the Shopify app',
      });
      return res.status(200).send('ok');
    }

    if (topic.startsWith('orders/') || topic.startsWith('fulfillments/')) {
      await upsertOrderFromPayload(admin, store, topic, payload);
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook processing error', { topic, shopDomain, err: err.message });
    return res.status(500).send('Processing error');
  }
}

async function upsertOrderFromPayload(admin, store, topic, payload) {
  const shopifyOrderId = String(payload.order_id || payload.id);
  if (!shopifyOrderId) return;

  const orderFields = {
    shopify_order_id: shopifyOrderId,
    shopify_store_id: store.id,
    order_number: payload.order_number || payload.name,
    customer_name: payload.customer
      ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim()
      : undefined,
    customer_email: payload.customer?.email || payload.email,
    currency: payload.currency,
    total_price: payload.total_price ? Number(payload.total_price) : undefined,
    financial_status: payload.financial_status,
    fulfillment_status: payload.fulfillment_status,
    order_status: payload.cancelled_at ? 'cancelled' : payload.closed_at ? 'closed' : 'open',
    shipping_address: payload.shipping_address || undefined,
    fulfilled_at: payload.fulfillments?.[0]?.created_at || undefined,
    updated_at: new Date().toISOString(),
  };

  const fulfillment = payload.fulfillments?.[0];
  if (fulfillment) {
    orderFields.tracking_number = fulfillment.tracking_number;
    orderFields.tracking_url = fulfillment.tracking_url;
    orderFields.carrier = fulfillment.tracking_company;
    orderFields.tracking_status = fulfillment.shipment_status;
    orderFields.last_tracking_update = fulfillment.updated_at;
  }

  Object.keys(orderFields).forEach((k) => orderFields[k] === undefined && delete orderFields[k]);

  const health = computeHealth(orderFields);
  orderFields.health_status = health.status;
  orderFields.health_reason = health.reason;

  const { data: order, error } = await admin
    .from('orders')
    .upsert(orderFields, { onConflict: 'shopify_store_id,shopify_order_id' })
    .select()
    .single();
  if (error) throw error;

  if (Array.isArray(payload.line_items)) {
    await admin.from('order_items').delete().eq('order_id', order.id);
    const items = payload.line_items.map((li) => ({
      order_id: order.id,
      shopify_product_id: String(li.product_id || ''),
      shopify_variant_id: String(li.variant_id || ''),
      product_title: li.title,
      quantity: li.quantity,
      price: li.price ? Number(li.price) : null,
    }));
    if (items.length) await admin.from('order_items').insert(items);
  }

  await admin.from('shopify_stores').update({ last_sync_at: new Date().toISOString() }).eq('id', store.id);

  await admin.from('activities').insert({
    user_id: store.user_id,
    shopify_store_id: store.id,
    activity_type: topic.startsWith('orders/') ? 'order_synced' : 'fulfillment_synced',
    description: `Order ${orderFields.order_number || shopifyOrderId} updated (${topic})`,
    metadata: { health_status: health.status },
  });
}
