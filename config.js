/* =========================================================
 *  CONFIGURAÇÃO DO SUPABASE  (banco de dados gratuito)
 * =========================================================
 *  1. Crie uma conta em https://supabase.com  → New Project
 *  2. No painel do projeto vá em: Settings → API
 *  3. Copie "Project URL"      → cole em SUPABASE_URL
 *  4. Copie "anon public key"  → cole em SUPABASE_ANON_KEY
 *
 *  Enquanto estiver vazio, o app funciona só com localStorage.
 * ========================================================= */

const SUPABASE_URL = 'https://xvidpjhwnwnrroefntvq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2aWRwamh3bnducnJvZWZudHZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDk3MTgsImV4cCI6MjEwMjk4NTcxOH0.SmR3axqdcsPOqALpYMm-6Gob7Ke9U9DQLmMVHO0Xt2g';

/* UID da conta dona (admin). Só essa conta vê a aba Admin e o painel. */
const ADMIN_USER_ID = '104915e0-319a-40db-a9f9-568bcaf2d456';

/* =========================================================
 *  LINKS DE PAGAMENTO (Mercado Pago)
 * =========================================================
 *  Crie cada link em https://www.mercadopago.com.br — menu
 *  "Pagamentos" → "+ Criar link de pagamento" (ou checkout).
 *  Cole a URL completa abaixo. Deixe '' enquanto não existir.
 *
 *  Após o pagamento, quem libera cristais/premium é você no
 *  painel Admin do Seals Focus (botões de adicionar cristais
 *  / ativar premium), confirmando o Pix recebido.
 * ========================================================= */

const PAYMENT_LINKS = {
  premiumMonthly: '', // Premium R$ 9,90/mês  → botão "Assinar Premium"
  pkg1: '',          // 300 cristais         → R$ 4,90
  pkg2: '',          // 900 cristais         → R$ 9,90
  pkg3: '',          // 2500 cristais        → R$ 19,90
  pkg4: ''           // 6000 cristais        → R$ 39,90 (Premium)
};
