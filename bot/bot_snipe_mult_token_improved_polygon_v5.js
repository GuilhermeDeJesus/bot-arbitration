// Carrega variáveis de ambiente do arquivo
require("dotenv").config({ path: "./config_rede_polygon.env" });
const { JsonRpcProvider, Wallet, Contract, parseUnits, MaxUint256, formatUnits, getAddress } = require("ethers");
const fs = require('fs');
const { exit } = require("process");

const quoteCache = new Map();
const QUOTE_TTL_MS = 2000; // 2 segundos

function getCacheKey(...args) {
    return args.join("|");
}
  
function setQuoteCache(key, value) {
    quoteCache.set(key, { value, timestamp: Date.now() });
}
  
function getQuoteCache(key) {
    const data = quoteCache.get(key);
    if (!data) return null;
    if (Date.now() - data.timestamp > QUOTE_TTL_MS) {
      quoteCache.delete(key);
      return null;
    }
    return data.value;
}

// Logger simples sem módulos externos
function log(msg, level = "info") {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase()}: ${msg}`;
  console.log(line);
  fs.appendFileSync("bot_arbitrage.log", line + "\n");

  fs.watchFile('bot_arbitrage.log', () => {
    const data = fs.readFileSync('bot_arbitrage.log', 'utf8');
    console.log('\n--- Log de Lucros ---\n');
    console.log(data.split('\n').slice(-10).join('\n')); // Mostra as últimas 10 linhas
  });
}

// Logger somente para trades lucrativos
function logProft(msg, level = "info") {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase()}: ${msg}`;
  console.log(line);
  fs.appendFileSync("bot_arbitrage_profits.log", line + "\n");

  fs.watchFile('bot_arbitrage_profits.log', () => {
    const data = fs.readFileSync('bot_arbitrage_profits.log', 'utf8');
    console.log('\n--- Log de Lucros ---\n');
    console.log(data.split('\n').slice(-10).join('\n')); // Mostra as últimas 10 linhas
  });
}

// Configurações do bot
const provider = new JsonRpcProvider(process.env.RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

// Configurações de trade
const TRADE_AMOUNT_USDC = parseUnits("125", 6);   // Valor fixo de trade: $1000 em USDC
const MIN_PROFIT_USD = 1;                         // Mínimo de lucro para executar operação
const INTERVAL = 5000;                            // Tempo entre verificações (5 segundos)
const MAX_DAILY_LOSS = 200;                       // Perda máxima diária permitida
const MAX_CONCURRENT_REQUESTS = 10;
const blacklist = new Set();                      // Guarda pares e rotas com erro
const reportData = [];                            // Histórico detalhado
const V3_FEES = [500, 3000, 10000];               // Pools V3 com diferentes faixas de taxa

let SLIPPAGE = 0.005;                             // Slippage padrão (0.5%)
let dailyLoss = 0;
let dailyProfit = 0;
let tradeCount = 0;

// const BASE_TOKEN = getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"); // USDC na Polygon
const BASE_TOKEN = getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"); // USDC na Polygon

// Tokens populares com boa liquidez
const TOKENS = {
  WETH: getAddress("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"),
  WBTC: getAddress("0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"),
  MATIC: getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),
  AAVE: getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"),
  miMATIC: getAddress('0xa3Fa99A148fA48D14Ed51d610c367C61876997F1')
};

// DEXs e seus tipos (v2 ou v3)
const ROUTERS = {
  uniswap:   { address: getAddress("0xE592427A0AEce92De3Edee1F18E0157C05861564"), type: "v3" }, // Contrato Router Verificado e Ok
  quickswap: { address: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"), type: "v2" }, // Contrato Router Verificado e Ok
  sushiswap: { address: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"), type: "v2" }, // Tem que testar
  kyberswap: { address: getAddress("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"), type: "v2" }, // Tem que testar
  // openocean:{ address: getAddress("0xa6c92c3f71e5e6757f83f5e6c3edc1b46c67b7d4"), type: "v2" },
  // shibaswap:{ address: getAddress("0x03f7724180AA6b939894B5Ca4314783B0b36b329"), type: "v2" }
};

// Aprovação e verificação de allowance
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)"
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
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)",
];

// Endereço do contrato Quoter
const UNISWAP_QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

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
  const cacheKey = getCacheKey("v2", routerAddress, path.join("-"), amountIn.toString());
  const cached = getQuoteCache(cacheKey);
  if (cached !== null) return cached;
  
  const exists = await checkV2PairExists(routerAddress, path[0], path[1]);
  
  if (!exists) {
    blacklist.add(key);
    return 0n;
  }
  try {
    const router = new Contract(routerAddress, V2_ROUTER_ABI, provider);
    const result = await router.getAmountsOut(amountIn, path);
    setQuoteCache(cacheKey, result[1]);
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
    const cacheKey = getCacheKey("v3", tokenIn, tokenOut, amountIn.toString(), fee);
    const cached = getQuoteCache(cacheKey);
    if (cached !== null) return { amountOut: cached, fee };
    const key = `v3:${tokenIn}-${tokenOut}-${fee}`;
    if (blacklist.has(key)) continue;
    try {
      const out = await quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
      setQuoteCache(cacheKey, out);
      if (out > 0n) return { amountOut: out, fee };
    } catch {
      blacklist.add(key);
    }
  }
  return { amountOut: 0n, fee: 0 };
}

// Garante que tokens tenham aprovação para swap (MaxUint)
async function ensureApproval(token, spender, amount) {
  const contract = new Contract(token, ERC20_ABI, wallet);
  const allowance = await contract.allowance(wallet.address, spender);

  if (allowance < amount) {
    log(`🔒 Aprovando ${amount} para ${spender}...`);
    try {
      const tx = await contract.approve(spender, amount);
      log(`⏳ TX enviada! Hash: ${tx.hash}`);
      await tx.wait();
      log(`✅ Aprovado ${amount} para ${spender}`, "info");
    } catch (err) {
      log(`❌ Erro ao aprovar: ${err.reason || err.message}`, "error");
    }
  } else {
    log("✅ Já aprovado, não precisa aprovar de novo", "info");
  }
  
}

// Cancela transações pendentes
async function cancelAllPendingTx() {

  const address = wallet.address;
  const nonceConfirmed = await provider.getTransactionCount(address, "latest");
  const noncePending = await provider.getTransactionCount(address, "pending");

  console.log(`🔢 Nonce confirmado: ${nonceConfirmed}`);
  console.log(`🕐 Nonce pendente:   ${noncePending}`);

  if (noncePending > nonceConfirmed) {
    console.log(`🚨 Cancelando todas as ${noncePending - nonceConfirmed} pendentes...`);
    const { gasPrice } = await provider.getFeeData();

    for (let nonce = nonceConfirmed; nonce < noncePending; nonce++) {
      const tx = await wallet.sendTransaction({
        to: address,
        value: 0,
        gasLimit: 21000n,
        gasPrice: gasPrice * 2n, // ou algum aumento dinâmico
        nonce
      });

      console.log(`📤 Cancelamento enviado (nonce ${nonce}): ${tx.hash}`);
      await tx.wait();
    }

    console.log("✅ Todas transações pendentes substituídas!");
  } else {
    console.log("✅ Nenhuma transação pendente detectada.");
  }
}

// Executa swap na DEX V2 com slippage e deadline
const SWAP_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

// Checagem de saldo
async function hasBalance(token, amount) {
  const contract = new Contract(token, ERC20_ABI, provider);
  const balance = await contract.balanceOf(wallet.address);
  return balance >= amount;
}
  
async function executeSwap(routerAddress, path, amountIn, amountOutMin, dexType = "v2", fee = 3000) {
  const [tokenIn, tokenOut] = path;

  if (!(await hasBalance(tokenIn, amountIn))) {
    return null;
  }

  try {
    await ensureApproval(tokenIn, routerAddress, amountIn);
    const deadline = Math.floor(Date.now() / 1000) + 120;
    log(`🔄 Executando swap ${dexType.toUpperCase()} de ${amountIn} ${tokenIn} para ${tokenOut} (min: ${amountOutMin})`, "info");

    if (dexType === "v2") {
      const _V2_ROUTER_ABI = [
        "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
        "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
      ];

      const router = new Contract(routerAddress, _V2_ROUTER_ABI, wallet);
      const tx = await router.swapExactTokensForTokens(amountIn, amountOutMin, path, wallet.address, deadline);
      const receipt = await tx.wait();
      log(`✅ Swap V2 ${tokenIn} → ${tokenOut} confirmado. Hash: ${receipt.transactionHash}`, "success");
      return receipt;
    }

    if (dexType === "v3") {
      if (path.length !== 2) {
        log(`❌ Para swaps V3, o path deve conter exatamente 2 tokens`, "error");
        return null;
      }

      const _SWAP_ROUTER_ABI = [
        "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
      ];

      const router = new Contract(routerAddress, _SWAP_ROUTER_ABI, wallet);
      const params = {
        tokenIn,
        tokenOut,
        fee,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60 * 10,
        amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0,
      };

      const tx = await router.exactInputSingle(params, { gasLimit: 200000, value: 0 });
      const receipt = await tx.wait();
      log(`✅ Swap V3 ${tokenIn} → ${tokenOut} confirmado. Hash: ${receipt.transactionHash}`, "success");
      return receipt;
    }

    log(`❌ Tipo de DEX desconhecido: ${dexType}`, "error");
    return null;

  } catch (err) {
    const errorMessage = err?.message || "Erro desconhecido";
    log(`❌ Erro no swap ${tokenIn} → ${tokenOut} (${dexType}): ${errorMessage} | ${JSON.stringify(err.transaction || {})}`, "error");
    return null;
  }
}
  
function saveTradeReport(data) {
  const timestamp = new Date().toISOString();
  const fileName = "report_summary.json";

  const summary = {
      timestamp,
      symbol: data.symbol,
      buyDex: data.buyDex,
      sellDex: data.sellDex,
      tradeAmountUSD: data.tradeAmountUSD,
      returnedAmountUSD: data.returnedAmountUSD,
      profit: data.profit,
      percent: data.percent
  };

  let existing = [];

  if (fs.existsSync(fileName)) {
      try {
          const parsed = JSON.parse(fs.readFileSync(fileName));
          if (Array.isArray(parsed)) {
              existing = parsed;
          } else {
              console.warn("⚠️ Arquivo report_summary.json não é um array. Substituindo...");
          }
      } catch (err) {
          console.error("❌ Erro ao ler report_summary.json:", err);
      }
  }

  existing.push(summary);
  fs.writeFileSync(fileName, JSON.stringify(existing, null, 2));
}

// Verifica se há saldo suficiente antes de tentar swap
async function hasSufficientBalance(token, amountRequired) {
  try {
    const erc20 = new Contract(token, ERC20_ABI, provider);
    const balance = await erc20.balanceOf(wallet.address);
    const required = typeof amountRequired === "bigint" ? amountRequired : BigInt(amountRequired);
    return balance >= required;
  } catch (err) {
    log(`Erro ao verificar saldo de ${token}: ${err.message}`, "error");
    return false;
  }
}

async function getTokenBalance(token) {
  try {
    const erc20 = new Contract(token, ERC20_ABI, provider);
    const balance = await erc20.balanceOf(wallet.address);
    // Converte o saldo para BigInt para facilitar operações com valores inteiros
    return BigInt(balance.toString());
  } catch (err) {
    log(`Erro ao verificar saldo de ${token}: ${err.message}`, "error");
    return 0n;
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
        const balance = await wallet.provider.getBalance(wallet.address);
        const minBalance = parseUnits("0.01", 18);
        console.log(`✅ Saldo de MATIC: ${formatUnits(balance, 18)} MATIC`);
        return balance >= minBalance;
    } catch (error) {
        console.error("Erro ao verificar saldo de MATIC:", error);
        return false;
    }
}

const LOCK_FILE = 'bot.lock';

// Tenta adquirir o lock
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) return false;
  fs.writeFileSync(LOCK_FILE, 'LOCK');
  return true;
}

// Libera o lock
function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

// Função principal
async function verificarOportunidades() {
    if (!acquireLock() || dailyLoss >= MAX_DAILY_LOSS) return;
    try {
        SLIPPAGE = adjustSlippage();

        for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {

            const tradeAmountFloat = parseFloat(formatUnits(TRADE_AMOUNT_USDC, 6));
            const promises = [];

            for (const [buyDex, buyInfo] of Object.entries(ROUTERS)) {
              for (const [sellDex, sellInfo] of Object.entries(ROUTERS)) {
              if (buyDex === sellDex) continue;

                await (async () => {
                    const amountOut = buyInfo.type === "v3"
                    ? (await getV3Quote(BASE_TOKEN, tokenAddress, TRADE_AMOUNT_USDC)).amountOut
                    : await getV2Quote(buyInfo.address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC);

                    if (amountOut === 0n) return;

                    const amountBack = sellInfo.type === "v3"
                    ? (await getV3Quote(tokenAddress, BASE_TOKEN, amountOut)).amountOut
                    : await getV2Quote(sellInfo.address, [tokenAddress, BASE_TOKEN], amountOut);

                    if (amountBack === 0n) return;

                    const priceBuy = parseFloat(formatUnits(amountOut, getTokenDecimals(symbol)));
                    const priceSell = parseFloat(formatUnits(amountBack, 6));
                    const profit = priceSell - tradeAmountFloat;
                    const percent = (profit / tradeAmountFloat) * 100;

                    const statusText = profit >= 0
                    ? `Lucro de $${formatCurrency(profit)} (+${percent.toFixed(2)}%) ✅ LUCRO`
                    : `Prejuízo de $${formatCurrency(profit)} (${percent.toFixed(2)}%) 🔻 PERDA`;

                    const logLine = `Arbitragem ${symbol}: ${buyDex}→${sellDex} (Vai $ ${formatCurrency(tradeAmountFloat)} Volta $ ${formatCurrency(priceSell)}) ${statusText}`;
                    log(logLine);
                    if (profit > 0) logProft(logLine);

                    // Teste Riri - :)

                    // Analisar o SWAP agora na versão V4 do bot
                    if (profit >= MIN_PROFIT_USD) {
                        const hasGas = await checkGasBalance(wallet);
                        if (!hasGas) return;

                        log(`>>> EXECUTANDO: ${symbol} | ${buyDex} → ${sellDex} | Lucro $${profit.toFixed(2)}`);
                        logProft(`>>> EXECUTANDO: ${symbol} | ${buyDex} → ${sellDex} | Lucro $${profit.toFixed(2)}`);

                        // const minTokenOut = amountOut * BigInt(10000 - SLIPPAGE * 10000) / 10000n;
                        const minTokenOut = BigInt(Math.floor((1 - SLIPPAGE) * 1e6)); // por ex. 990000 para 1%
                        const minUSDC = BigInt(amountBack) * minTokenOut / 1_000_000n;
                        
                        // Verifica saldo suficiente antes de aprovar e executar
                        const hasUSDC = await hasSufficientBalance(BASE_TOKEN, TRADE_AMOUNT_USDC);
                                                
                        if (hasUSDC) {

                            // await ensureApproval(BASE_TOKEN, buyInfo.address, TRADE_AMOUNT_USDC);
                            // await ensureApproval(tokenAddress, sellInfo.address, amountOut);
    
                            // Compra
                            await executeSwap(buyInfo.address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC, minTokenOut, buyInfo.type, buyInfo.type === "v3" ? (await getV3Quote(BASE_TOKEN, tokenAddress, TRADE_AMOUNT_USDC)).fee : undefined);

                            // Venda
                            const availableBalance = await getTokenBalance(tokenAddress);
                            await executeSwap(
                              sellInfo.address,                    // Endereço do router da DEX de venda
                              [tokenAddress, BASE_TOKEN],         // Path: de token de venda para token base
                              availableBalance,                   // Usando o saldo disponível como quantidade de entrada
                              minUSDC,                            // Valor mínimo de saída (ajustado conforme slippage)
                              sellInfo.type,                       // Tipo de DEX (v3, por exemplo)
                              sellInfo.type === "v3"
                                ? (await getV3Quote(tokenAddress, BASE_TOKEN, availableBalance)).fee
                                : undefined
                            );

                            saveTradeReport({
                                symbol,
                                buyDex,
                                sellDex,
                                tradeAmountUSD: tradeAmountFloat,
                                returnedAmountUSD: priceSell,
                                profit,
                                percent
                            });                                                    
                        }

                        dailyProfit += profit;
                        tradeCount++;

                        reportData.push({
                            timestamp: new Date().toISOString(),
                            token: symbol,
                            buyDex,
                            sellDex,
                            priceBuy,
                            priceSell,
                            profit,
                            percent
                        });

                        fs.writeFileSync("report.json", JSON.stringify(reportData, null, 2));
                        fs.writeFileSync("report_summary.json", JSON.stringify({
                            date: new Date().toISOString().slice(0, 10),
                            totalProfit: dailyProfit.toFixed(2),
                            totalTrades: tradeCount,
                            totalLoss: dailyLoss.toFixed(2),
                        }, null, 2));
                        return true; // Sinaliza que houve execução
                    }
                  })();
                }
            }

            const results = await Promise.all(promises);
            if (results.some(res => res === true)) return; // Sai se já executou uma arbitragem
        }
    } finally {
        releaseLock();
    }
}

// verificarOportunidades();

// Loop principal
setInterval(verificarOportunidades, INTERVAL);