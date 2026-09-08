// POST /api/mp-webhook  (notificação do Mercado Pago)
// Confere o pagamento na API do MP, grava no payments_log (idempotente)
// e credita cristais / ativa Premium. Nunca confia no corpo da notificação.
const { ITEMS } = require('./config');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).end(); // MP aceita o recebimento na hora
  if (req.method !== 'POST') return;

  try {
    const { type, data } = req.body || {};
    const paymentId = data && data.id;
    if (!paymentId || (type && type !== 'payment')) return;

    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) return;

    const payRes = await fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!payRes.ok) return;
    const payment = await payRes.json();
    if ((payment.status || '').toLowerCase() !== 'approved') return;

    const ref = String(payment.external_reference || '');
    const sep = ref.lastIndexOf('::');
    if (sep < 0) return;
    const itemId = ref.slice(0, sep);
    const userId = ref.slice(sep + 2);
    const item = ITEMS[itemId];
    if (!item || !userId) return;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // 1) Registra UMA única vez (retorna false se já processado)
    const rec = await sb.rpc('payment_record', {
      p_payment_id: paymentId,
      p_user_id: userId,
      p_item_id: itemId,
      p_amount: payment.transaction_amount || 0,
    });
    if (rec.error || rec.data === false) return;

    // 2) Credita
    if (item.crystals) {
      const r = await sb.rpc('payment_add_crystals', { p_user_id: userId, p_amount: item.crystals });
      if (r.error) console.error('payment_add_crystals:', r.error.message);
    }
    if (item.premium) {
      const r = await sb.rpc('payment_set_premium', { p_user_id: userId });
      if (r.error) console.error('payment_set_premium:', r.error.message);
    }
  } catch (err) {
    console.error('/api/mp-webhook:', err);
  }
};