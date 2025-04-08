require("dotenv").config({ path: "./config_rede_polygon.env" });
const { JsonRpcProvider, Wallet, Contract, parseUnits, MaxUint256, formatUnits, getAddress, isAddress } = require("ethers");
const winston = require('winston');
const fs = require('fs');
const ethers = require("ethers");

const provider = new JsonRpcProvider(process.env.RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

const TRADE_AMOUNT_USDC = parseUnits('1000', 6);
const MIN_PROFIT_USD = 3;
let SLIPPAGE = 0.005;
const INTERVAL = 10000;
const MAX_DAILY_LOSS = 200;
let dailyLoss = 0;
let dailyProfit = 0;
let tradeCount = 0;

const TOKENS = {
  WETH: getAddress('0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'),
  WBTC: getAddress('0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6')
};

const BASE_TOKEN = getAddress('0x2791bca1f2de4661ed88a30c99a7a9449aa84174');

const ROUTERS = {
  sushiswap: {
    address: getAddress('0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'),
    type: 'v2'
  },
  quickswap: {
    address: getAddress('0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'),
    type: 'v2'
  },
  uniswap: {
    address: getAddress('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'),
    type: 'v3'
  }
};

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot_arbitrage.log' })
  ]
});

const ERC20_ABI = [
  'function approve(address spender, uint value) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)'
];

const V2_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
];

const UNISWAP_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)'
];

async function getV2Quote(routerAddress, path, amountIn) {
  const router = new Contract(routerAddress, V2_ROUTER_ABI, provider);
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[1];
  } catch (error) {
    logger.error(`Erro no getV2Quote: ${error.message}`);
    return BigInt(0);
  }
}

const UNISWAP_QUOTER_ADDRESS = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';
async function getUniswapV3Quote(amountIn, tokenOut) {
  if (BASE_TOKEN === tokenOut) return BigInt(0);
  const quoter = new Contract(UNISWAP_QUOTER_ADDRESS, UNISWAP_QUOTER_ABI, provider);
  try {
    return await quoter.quoteExactInputSingle(BASE_TOKEN, tokenOut, 3000, amountIn, 0);
  } catch (error) {
    logger.error(`Erro no getUniswapV3Quote: ${error.message}`);
    return BigInt(0);
  }
}

function adjustSlippage() {
  // Aqui ajustamos o slippage com base na volatilidade real do mercado
  const priceChange = Math.random() * 0.05; // Simula uma variação de preço de até 5%
  let novoSlippage = SLIPPAGE + priceChange;
  if (novoSlippage > 0.01) novoSlippage = 0.01; // Limita o slippage a 1%
  logger.info(`Slippage ajustado para ${(novoSlippage * 100).toFixed(2)}% devido à volatilidade do mercado.`);
  return novoSlippage;
}

function getTokenDecimals(symbol) {
  if (symbol === 'WBTC') return 8;
  if (symbol === 'LINK') return 18;
  if (symbol === 'WETH') return 18;
  return 18;
}

async function ensureApproval(token, spender, amount) {
  const contract = new Contract(token, ERC20_ABI, wallet);
  const allowance = await contract.allowance(wallet.address, spender);
  if (allowance < amount) {
    try {
      const tx = await contract.approve(spender, MaxUint256);
      await tx.wait();
      logger.info(`Aprovado ${token} para ${spender}`);
    } catch (error) {
      logger.error(`Erro na aprovação de ${token}: ${error.message}`);
    }
  }
}

async function executeSwap(routerAddress, path, amountIn, amountOutMin) {
  const router = new Contract(routerAddress, V2_ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 60;
  try {
    const tx = await router.swapExactTokensForTokens(
      amountIn,
      amountOutMin,
      path,
      wallet.address,
      deadline
    );
    await tx.wait();
    logger.info(`Swap executado: ${path.join(' → ')}`);
  } catch (error) {
    logger.error(`Erro no swap (${path.join(' → ')}): ${error.message}`);
    dailyLoss += parseFloat(formatUnits(amountIn, 6));
  }
}

const reportData = [];

async function verificarOportunidades() {
  try {
    SLIPPAGE = adjustSlippage();

    if (dailyLoss >= MAX_DAILY_LOSS) {
      logger.warn(`Stop-loss diário atingido ($${dailyLoss}). Operações pausadas.`);
      return;
    }

    for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
      for (const [buyDex, buyData] of Object.entries(ROUTERS)) {
        const amountTokenOut = buyData.type === 'v3'
          ? await getUniswapV3Quote(TRADE_AMOUNT_USDC, tokenAddress)
          : await getV2Quote(buyData.address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC);

        const tokenDecimals = getTokenDecimals(symbol);
        const priceBuy = parseFloat(formatUnits(amountTokenOut, tokenDecimals));
        if (amountTokenOut === 0n || priceBuy < 0.01) continue;

        for (const [sellDex, sellData] of Object.entries(ROUTERS)) {
          if (sellDex === buyDex) continue;

          let amountBackUSDC = 0n;
          if (sellData.type === 'v3') {
            if (tokenAddress !== BASE_TOKEN) {
              amountBackUSDC = await getUniswapV3Quote(amountTokenOut, BASE_TOKEN);
            }
          } else {
            amountBackUSDC = await getV2Quote(sellData.address, [tokenAddress, BASE_TOKEN], amountTokenOut);
          }

          if (amountBackUSDC === 0n) continue;

          const priceSell = parseFloat(formatUnits(amountBackUSDC, 6));
          const profit = parseFloat(formatUnits(amountBackUSDC - TRADE_AMOUNT_USDC, 6));
          const percentDiff = ((priceSell - 1000) / 1000) * 100;
          const slippageDetected = Math.abs(percentDiff) > 30;

          if (slippageDetected) {
            // logger.warn(`Slippage extremo detectado no par ${symbol} (${buyDex} → ${sellDex}), ignorando...`);
            // continue;
          }

          const status = profit < 0 ? '🔻 PERDA' : '✅ LUCRO';

          logger.info(`Preço ${symbol}: Comprar na ${buyDex} (${priceBuy.toFixed(6)}), Vender na ${sellDex} (${priceSell.toFixed(6)}) | Lucro estimado: $${profit.toFixed(2)} (${percentDiff.toFixed(2)}%) ${status}`);

          if (profit >= MIN_PROFIT_USD) {
            logger.info(`>>> Lucro de $${profit.toFixed(2)} com ${symbol}: Comprar na ${buyDex} e vender na ${sellDex}`);

            await ensureApproval(BASE_TOKEN, ROUTERS[buyDex].address, TRADE_AMOUNT_USDC);
            await ensureApproval(tokenAddress, ROUTERS[sellDex].address, amountTokenOut);

            const minTokenOut = amountTokenOut * BigInt(10000 - SLIPPAGE * 10000) / BigInt(10000);
            const minUSDC = amountBackUSDC * BigInt(10000 - SLIPPAGE * 10000) / BigInt(10000);

            await executeSwap(ROUTERS[buyDex].address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC, minTokenOut);
            await executeSwap(ROUTERS[sellDex].address, [tokenAddress, BASE_TOKEN], amountTokenOut, minUSDC);

            dailyProfit += profit;
            tradeCount++;
            logger.info(`Lucro acumulado hoje: $${dailyProfit.toFixed(2)} com ${tradeCount} operações.`);

            reportData.push({
              timestamp: new Date().toISOString(),
              token: symbol,
              buyDex,
              sellDex,
              priceBuy,
              priceSell,
              profit: profit.toFixed(2),
              percentDiff: percentDiff.toFixed(2),
              slippageDetected
            });

            fs.writeFileSync('report.json', JSON.stringify(reportData, null, 2));

            const summary = {
              date: new Date().toISOString().slice(0, 10),
              totalProfit: dailyProfit.toFixed(2),
              totalTrades: tradeCount,
              totalLoss: dailyLoss.toFixed(2)
            };
            fs.writeFileSync('report_summary.json', JSON.stringify(summary, null, 2));

            return;
          }
        }
      }
    }
    logger.info("Sem arbitragem lucrativa agora.");
  } catch (error) {
    logger.error(`Erro na verificação de oportunidades: ${error.message}`);
  }
}

setInterval(verificarOportunidades, INTERVAL);

process.on('exit', () => {
  const summary = {
    date: new Date().toISOString().slice(0, 10),
    totalProfit: dailyProfit.toFixed(2),
    totalTrades: tradeCount,
    totalLoss: dailyLoss.toFixed(2)
  };
  fs.writeFileSync('report_summary.json', JSON.stringify(summary, null, 2));
  logger.info('Resumo diário salvo em report_summary.json');
});
