/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Minha Lógica Final - Fazendo Teste - Ajuste Necessários
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

log(`Proft: ${profit}`);
if(profit > -2.00){

    // cancelAllPendingTx();
    // await sleep(2000);

    // const minTokenOut = amountOut * BigInt(10000 - SLIPPAGE * 10000) / 10000n;
    // const minTokenOut = BigInt(Math.floor(10000 - SLIPPAGE * 10000));
    // const minUSDC = amountBack * minTokenOut / 10000n;

    switch (buyDex) {
        case 'quickswap':
        case 'uniswap':
        case 'sushiswap':
        case 'kyberswap':

        log(`Lógica Swap Para: ${buyDex}`);
        const minTokenOut = BigInt(Math.floor((1 - SLIPPAGE) * 1e6)); // por ex. 990000 para 1%
        const minUSDC = BigInt(amountBack) * minTokenOut / 1_000_000n;

        // Verifica saldo suficiente antes de aprovar e executar
        const hasUSDC = await hasSufficientBalance(BASE_TOKEN, TRADE_AMOUNT_USDC);

        if (hasUSDC) {

        // await ensureApproval(BASE_TOKEN, buyInfo.address, TRADE_AMOUNT_USDC);
        // await ensureApproval(tokenAddress, sellInfo.address, amountOut);

        log(`AmountIn Entrada ${TRADE_AMOUNT_USDC}`);
        log(`AmountOutMinimum Entrada ${minTokenOut}`);
        log(`✅ Fazendo Swap de Compra na DEX: ${buyDex} - Address: ${buyInfo.address}`);
        // Compra
        // const amountOutFirst = await executeSwapUniSwap(buyInfo.address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC, minTokenOut, buyInfo.type, buyInfo.type === "v3" ? (await getV3Quote(BASE_TOKEN, tokenAddress, TRADE_AMOUNT_USDC)).fee : undefined);
        await executeSwap(buyInfo.address, [BASE_TOKEN, tokenAddress], TRADE_AMOUNT_USDC, minTokenOut, buyInfo.type, buyInfo.type === "v3" ? (await getV3Quote(BASE_TOKEN, tokenAddress, TRADE_AMOUNT_USDC)).fee : undefined);

        log(`AmountIn Saída ${amountOut}`);
        log(`AmountOutMinimum Saída ${minUSDC}`);
        log(`❌ Fazendo Swap de Venda na DEX: ${sellDex} - Address: ${sellInfo.address}`);
        // Venda
        const availableBalance = await getTokenBalance(tokenAddress);
        log(`Disponível para venda: ${availableBalance}`);
        // await executeSwapUniSwap(sellInfo.address, [tokenAddress, BASE_TOKEN], amountOut, minUSDC, sellInfo.type, sellInfo.type === "v3" ? (await getV3Quote(tokenAddress, BASE_TOKEN, amountOut)).fee : undefined);
        // Para executar a venda, usamos o saldo disponível como amountIn
        
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
        break;
    }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Fim //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////