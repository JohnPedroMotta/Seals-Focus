// POST /api/create-checkout
// { itemId, userId } -> cria checkout no Mercado Pago e devolve { init_point }.
// Cristais = pagamento único. Premium = pagamento único que concede meses
// (Pix, QR ou cartão, sem exigir conta Mercado Pago do cliente).
const { ITEMS } = require('./config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  try {
    const { itemId, userId } = req.body || {};
    const item = ITEMS[itemId];
    if (!item) return res.status(400).json({ error: 'Item inválido.' });
    if (!userId) return res.status(400).json({ error: 'Usuário não identificado.' });

    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) {
      return res.status(500).json({ error: 'Pagamento ainda não configurado (falta MP_ACCESS_TOKEN nas variáveis de ambiente).' });
    }

    const origin = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

    const body = {
      items: [{ id: itemId, title: item.title, quantity: 1, unit_price: item.price, currency_id: 'BRL' }],
      external_reference: itemId + '::' + userId,
      notification_url: origin + '/api/mp-webhook',
      back_urls: {
        success: origin + '/?pay=success',
        pending: origin + '/?pay=pending',
        failure: origin + '/?pay=failure',
      },
      auto_return: 'approved',
      statement_descriptor: 'SEALS FOCUS',
    };

    // Checkout Pro aceita Pix/QR: o cliente paga pelo próprio banco, sem conta MP
    const mp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await mp.json();
    if (!mp.ok) {
      console.error('MP create-preference failed:', JSON.stringify(json));
      return res.status(502).json({ error: 'O Mercado Pago recusou o pagamento.', detail: json });
    }
    res.json({ init_point: json.init_point });
  } catch (err) {
    console.error('/api/create-checkout:', err);
    res.status(500).json({ error: 'Erro ao criar o pagamento. Tente novamente.' });
  }
};