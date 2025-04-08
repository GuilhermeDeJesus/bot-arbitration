// === BOT DE ARBITRAGEM COMPLETO EM UM ÚNICO ARQUIVO ===

// Carrega variáveis de ambiente do arquivo
require("dotenv").config({ path: "./config_rede_polygon.env" });
const { JsonRpcProvider, Wallet, Contract, parseUnits, MaxUint256, formatUnits, getAddress } = require("ethers");
const fs = require('fs');

// Logger simples sem módulos externos
function log(msg, level = "info") {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase()}: ${msg}`;
  console.log(line);
  fs.appendFileSync("bot_arbitrage.log", line + "\n");
}

// Logger somente para trades lucrativos
function logProft(msg, level = "info") {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase()}: ${msg}`;
  console.log(line);
  fs.appendFileSync("bot_arbitrage_profits.log", line + "\n");
}

// Configurações do bot
const provider = new JsonRpcProvider(process.env.RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

// Configurações de trade
const TRADE_AMOUNT_USDC = parseUnits("500", 6);  // Valor fixo de trade: $1000 em USDC
const MIN_PROFIT_USD = 1;                         // Mínimo de lucro para executar operação
let SLIPPAGE = 0.005;                             // Slippage padrão (0.5%)
const INTERVAL = 5000;                            // Tempo entre verificações (5 segundos)
const MAX_DAILY_LOSS = 200;                       // Perda máxima diária permitida

let dailyLoss = 0;
let dailyProfit = 0;
let tradeCount = 0;
const blacklist = new Set();     // Guarda pares e rotas com erro
const reportData = [];           // Histórico detalhado

const BASE_TOKEN = getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174"); // USDC na Polygon

// Tokens populares com boa liquidez
const TOKENS = {
  WETH: getAddress("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"),
  WBTC: getAddress("0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"),
  LINK: getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"),
  MATIC: getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),
  AAVE: getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"),
  DAI: getAddress("0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"),
  FRAX: getAddress('0x45c32fa6df82ead1e2ef74d17b76547eddfaff89'),
  miMATIC: getAddress('0xa3Fa99A148fA48D14Ed51d610c367C61876997F1'),
  GHST: getAddress('0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7'),
  SAND: getAddress('0xbbba073c31bf03b8acf7c28ef0738decf3695683'),
  BAL: getAddress('0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3'),
  UNI: getAddress('0xb33EaAd8d922B1083446DC23f610c2567fB5180f'),
  CRV: getAddress('0x172370d5cd63279efa6d502dab29171933a610af')
};

// DEXs e seus tipos (v2 ou v3)
const ROUTERS = {
  sushiswap: { address: getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"), type: "v2" },
  quickswap: { address: getAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"), type: "v3" },
  uniswap:  { address: getAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"), type: "v3" },
  kyberswap:{ address: getAddress("0x546C79662E028B661dFB4767664d0273184E4dD1"), type: "v3" },
  openocean:{ address: getAddress("0xa6c92c3f71e5e6757f83f5e6c3edc1b46c67b7d4"), type: "v2" },
  shibaswap:{ address: getAddress("0x03f7724180AA6b939894B5Ca4314783B0b36b329"), type: "v2" },
};

// Aprovação e verificação de allowance
const ERC20_ABI = [
  "function approve(address spender, uint value) public returns (bool)",
  "function allowance(address owner, address spender) public view returns (uint256)"
];

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
];

// Para cotação e swap em DEXs V2
const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

// Para verificar existência de par
const UNISWAP_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)"
];

// Endereço do contrato Quoter
const UNISWAP_QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

// Pools V3 com diferentes faixas de taxa
const V3_FEES = [500, 3000, 10000];

// Adiciona variação aleatória ao slippage
function adjustSlippage() {
  const rand = Math.random() * 0.05;
  return Math.min(SLIPPAGE + rand, 0.01);
}

// WBTC tem 8 casas decimais, os outros 18
function getTokenDecimals(symbol) {
  if (symbol === "WBTC") return 8;
  return 18;
}

// Garante que tokens tenham aprovação para swap (MaxUint)
async function ensureApproval(token, spender, amount) {
  const contract = new Contract(token, ERC20_ABI, wallet);
  const allowance = await contract.allowance(wallet.address, spender);
  if (allowance < amount) {
    const tx = await contract.approve(spender, MaxUint256);
    await tx.wait();
  }
}

// Verifica se par existe antes de tentar cotar (V2)
async function checkV2PairExists(routerAddress, tokenIn, tokenOut) {
  try {
    const router = new Contract(routerAddress, ["function factory() view returns (address)"], provider);
    const factoryAddress = await router.factory();
    const factory = new Contract(factoryAddress, V2_FACTORY_ABI, provider);
    const pair = await factory.getPair(tokenIn, tokenOut);
    return pair !== "0x0000000000000000000000000000000000000000";
  } catch {
    return false;
  }
}

// Retorna cotação de um par em DEX V2
async function getV2Quote(routerAddress, path, amountIn) {
  const key = `${routerAddress}:${path.join("-")}`;
  if (blacklist.has(key)) return 0n;
  const exists = await checkV2PairExists(routerAddress, path[0], path[1]);
  if (!exists) {
    blacklist.add(key);
    return 0n;
  }
  try {
    const router = new Contract(routerAddress, V2_ROUTER_ABI, provider);
    const result = await router.getAmountsOut(amountIn, path);
    return result[1];
  } catch {
    blacklist.add(key);
    return 0n;
  }
}

// Retorna cotação de um par em DEX V3 testando várias taxas
async function getV3Quote(tokenIn, tokenOut, amountIn) {
  const quoter = new Contract(UNISWAP_QUOTER_ADDRESS, UNISWAP_QUOTER_ABI, provider);
  for (const fee of V3_FEES) {
    const key = `v3:${tokenIn}-${tokenOut}-${fee}`;
    if (blacklist.has(key)) continue;
    try {
      const out = await quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
      if (out > 0n) return { amountOut: out, fee };
    } catch {
      blacklist.add(key);
    }
  }
  return { amountOut: 0n, fee: 0 };
}

// Executa swap na DEX V2 com slippage e deadline
async function executeSwap(routerAddress, path, amountIn, amountOutMin) {
  const router = new Contract(routerAddress, V2_ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 60;
  try {
    const tx = await router.swapExactTokensForTokens(amountIn, amountOutMin, path, wallet.address, deadline);
    await tx.wait();
  } catch (err) {
    log(`Erro no swap ${path.join("→")}: ${err.message}`, "error");
    dailyLoss += parseFloat(formatUnits(amountIn, 6));
  }
}

function formatCurrency(value) {
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function checkGasBalance(wallet) {
  try {
    if (!wallet.provider) {
      throw new Error("Wallet não está conectada a um provider.");
    }

    const balance = await wallet.provider.getBalance(wallet.address);
    const minBalance = parseUnits("0.01", 18);

    if (balance < minBalance) {
      console.warn(`⚠️ Saldo de MATIC insuficiente: ${formatUnits(balance, 18)} MATIC`);
    } else {
      console.log(`✅ Saldo de MATIC: ${formatUnits(balance, 18)} MATIC`);
    }
  } catch (error) {
    console.error("Erro ao verificar saldo de MATIC:", error);
  }
}

let running = false;

// Função principal
async function verificarOportunidades() {

  if (running || dailyLoss >= MAX_DAILY_LOSS) return;
    running = true;
    try {
      if (dailyLoss >= MAX_DAILY_LOSS) return;
      SLIPPAGE = adjustSlippage();
    
      for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
        for (const [buyDex, buyInfo] of Object.entries(ROUTERS)) {
    
          // Cotação de compra: USDC → TOKEN
          const amountOut = buyInfo.type === "v3"
            ? (await getV3Quote(BASE_TOKEN, tokenAddress, TRADE_AMOUNT_USDC)).amountOut
            : await getV2Quote(buyInfo.address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC);
    
          if (amountOut === 0n) continue;
          const priceBuy = parseFloat(formatUnits(amountOut, getTokenDecimals(symbol)));
    
          for (const [sellDex, sellInfo] of Object.entries(ROUTERS)) {
            if (sellDex === buyDex) continue;
    
            // Cotação de venda: TOKEN → USDC
            const amountBack = sellInfo.type === "v3"
              ? (await getV3Quote(tokenAddress, BASE_TOKEN, amountOut)).amountOut
              : await getV2Quote(sellInfo.address, [tokenAddress, BASE_TOKEN], amountOut);
    
            if (amountBack === 0n) continue;
    
            // Converta o TRADE_AMOUNT_USDC para número decimal
            const tradeAmount = parseFloat(formatUnits(TRADE_AMOUNT_USDC, 6));
            const priceSell = parseFloat(formatUnits(amountBack, 6));
            const profit = priceSell - tradeAmount;
            const percent = ((priceSell - tradeAmount) / tradeAmount) * 100;
    
            // Mensagem detalhada
            const statusText = profit >= 0
              ? `Lucro de $${formatCurrency(profit)} (+${percent.toFixed(2)}%) ✅ LUCRO`
              : `Prejuízo de $${formatCurrency(profit)} (${percent.toFixed(2)}%) 🔻 PERDA`;
    
            const priceBuyText = priceBuy.toFixed(2);
            const priceSellText = priceSell.toFixed(2);
    
            if(profit > 0){
              logProft(`Arbitragem ${symbol}: ${buyDex}→${sellDex} (Vai $ ${formatCurrency(parseFloat(formatUnits(TRADE_AMOUNT_USDC, 6)))} Volta $ ${formatCurrency(priceSell)}) ${statusText}`);
            }
    
            log(`Arbitragem ${symbol}: ${buyDex}→${sellDex} (Vai $ ${formatCurrency(parseFloat(formatUnits(TRADE_AMOUNT_USDC, 6)))} Volta $ ${formatCurrency(priceSell)}) ${statusText}`);
    
            if (profit >= MIN_PROFIT_USD) {
              log(`>>> EXECUTANDO: ${symbol} | ${buyDex} → ${sellDex} | Lucro $${profit.toFixed(2)}`);
              logProft(`>>> EXECUTANDO: ${symbol} | ${buyDex} → ${sellDex} | Lucro $${profit.toFixed(2)}`);
              const hasGas = await checkGasBalance(wallet);
              if(hasGas){
    
                // Aprova tokens para swap
                await ensureApproval(BASE_TOKEN, buyInfo.address, TRADE_AMOUNT_USDC);
                await ensureApproval(tokenAddress, sellInfo.address, amountOut);
    
                // Aplica slippage para definir mínimos
                const minTokenOut = amountOut * BigInt(10000 - SLIPPAGE * 10000) / 10000n;
                const minUSDC = amountBack * BigInt(10000 - SLIPPAGE * 10000) / 10000n;
    
                // Executa os swaps (ida e volta)
                await executeSwap(buyInfo.address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC, minTokenOut);
                await executeSwap(sellInfo.address, [tokenAddress, BASE_TOKEN], amountOut, minUSDC);
    
                dailyProfit += profit;
                tradeCount++;
    
                reportData.push({ timestamp: new Date().toISOString(), token: symbol, buyDex, sellDex, priceBuy, priceSell, profit, percent });
                fs.writeFileSync("report.json", JSON.stringify(reportData, null, 2));
                fs.writeFileSync("report_summary.json", JSON.stringify({
                  date: new Date().toISOString().slice(0, 10),
                  totalProfit: dailyProfit.toFixed(2),
                  totalTrades: tradeCount,
                  totalLoss: dailyLoss.toFixed(2),
                }, null, 2));
    
                return; // Sai após executar 1 arbitragem
              }
            }
          }
        }
      }
    } finally {
      running = false;
    }
}

// Loop principal
setInterval(verificarOportunidades, INTERVAL);

// Salva relatório ao sair
process.on("exit", () => {
  fs.writeFileSync("report_summary.json", JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    totalProfit: dailyProfit.toFixed(2),
    totalTrades: tradeCount,
    totalLoss: dailyLoss.toFixed(2),
  }, null, 2));
});
