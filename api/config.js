// Catálogo (lado servidor). Preços autoritativos da loja.
// Só existe AQUI/env vars — nunca mude preço apenas no client.
const ITEMS = {
  pkg1: { title: 'Pacote Pequeno de Cristais', price: 4.90, crystals: 300 },
  pkg2: { title: 'Pacote Médio de Cristais', price: 9.90, crystals: 900 },
  pkg3: { title: 'Pacote Grande de Cristais', price: 19.90, crystals: 2500 },
  pkg4: { title: 'Pacote Mestre de Cristais', price: 39.90, crystals: 6000 },
  premiumMonthly: { title: 'Premium Seals Focus — Mensal', price: 9.90, premium: 1 },
  premiumYearly: { title: 'Premium Seals Focus — Anual', price: 69.90, premium: 12 },
};

module.exports = { ITEMS };