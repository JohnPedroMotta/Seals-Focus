# Seals Focus

Plataforma de produtividade para estudos que combina um timer de foco, registro de sessões, painel de estatísticas, sistema de conquistas e loja — com sincronização entre dispositivos via Supabase.

## Funcionalidades

- **Timer de Focu** — Cronômetro configurável com alertas sonoros e anel de progresso visual
- **Registro de Sessões** — Sessões salvas no Supabase, categorizadas por matéria
- **Histórico** — Navegação por sessões anteriores com filtros e paginação
- **Estatísticas** — Gráficos diários/semanais/mensais, melhores sequências, horas produtivas
- **Sistema de Conquistas** — 20+ conquistas (primeira sessão, sequências, marcos)
- **Loja** — Moedas ganhas em sessões desbloqueiam temas e extras
- **Sistema de Amigos** — Convidar amigos, ver estatísticas e comparar desempenho
- **Perfil** — Nome, bio e cor de avatar editáveis
- **Sincronização** — Dados sincronizados a cada 15 minutos via Supabase
- **Painel Admin** — Painel protegido para gerenciamento de usuários
- **Tema Escuro** — Interface escura com CSS custom properties
- **Responsivo** — Layout com sidebar e menu hamburguer para mobile

## Tecnologias

| Camada | Tecnologia |
|--------|-----------|
| Frontend | HTML5, CSS3, JavaScript (ES6+) |
| Backend/Banco | Supabase (PostgreSQL, Auth, Realtime, RLS) |
| Ícones | Tabler Icons v3.32.0 |
| Fontes | Inter + Space Grotesk (Google Fonts) |
| Deploy | Vercel |

## Estrutura

```
programa/
├── index.html              # SPA principal
├── login.html              # Página de autenticação
├── login.js                # Lógica de auth do Supabase
├── script.js               # Lógica principal do app
├── style.css               # Estilos completos
├── config.js               # Configurações do Supabase
├── schema.sql              # Schema do banco (sessões, matérias, RLS)
├── migration_conquistas.sql # Migração de conquistas e perfis
├── seal.svg                # Logo/mascote
└── vercel.json             # Configuração do Vercel
```

## Setup

1. Clone o repositório
2. Configure as credenciais do Supabase em `config.js`
3. Execute os scripts SQL (`schema.sql` e `migration_conquistas.sql`) no painel do Supabase
4. Acesse `login.html` para criar uma conta ou fazer login
5. O timer e todas as funcionalidades estarão disponíveis na tela principal

## Deploy

O projeto está configurado para deploy automático no Vercel via GitHub. Basta fazer push para a branch `main`.
