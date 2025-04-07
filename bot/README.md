# 🤖 Bot de Arbitragem em DEXs na Polygon

Este é um bot de arbitragem automatizado que opera entre diferentes DEXs (como Uniswap, Sushiswap, Quickswap, Kyberswap) na rede **Polygon**, utilizando o token **USDC** como base.

---

## 🚀 Funcionalidades

- Detecção de oportunidades de arbitragem entre DEXs V2 e V3
- Execução automática de swaps com controle de slippage
- Verificação e aprovação de `allowance`
- Logs detalhados e persistentes (inclusive somente de lucros)
- Cancelamento automático de transações pendentes
- Cache de cotações para performance
- Relatórios JSON de cada operação com lucro/prejuízo
- Controle de risco diário por limite de perda

---

## 🔧 Tecnologias e Dependências

- Node.js
- ethers.js (`v6.13.5`)
- dotenv
- fs (file system)

---

## 📦 Instalação

1. Clone o repositório:
   ```bash
   git clone https://github.com/GuilhermeDeJesus/bot-arbitration.git
