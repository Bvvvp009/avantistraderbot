const { ethers, toBigInt } = require("ethers");

async function getTrades(trader, contractInstance) {
  /**
   * Fetches trades and pending limit orders for a specific trader.
   *
   * @param {string} trader - The trader's wallet address.
   * @param {Object} contractInstance - The Multicall contract instance.
   * @returns {Object} - Object containing filtered trades and pendingOpenLimitOrders.
   */

  // Fetch result from the contract
  const result = await contractInstance.getPositions(trader);

  const trades = [];
  const pendingOpenLimitOrders = [];

  // Process the list of aggregated trades
  for (const aggregatedTrade of result[0]) {
    const [trade, tradeInfo, marginFee, liquidationPrice] = aggregatedTrade;


    // Only include trades with valid leverage > 0
    if (toBigInt(trade[7]) <= 0n) continue;

    console.log(`Trade : ${trade} \n
      -Trade Info : ${tradeInfo} \n
      -Buy : ${trade[6]} \n
      - Margin Fee: ${marginFee} \n
      -Liquidation Price: ${liquidationPrice}`)

    // Extract and format the trade data
    const tradeDetails = {
      trader: trade[0],
      pairIndex: trade[1],
      index: trade[2],
      initialPosToken: toBigInt(trade[3]).toString(),
      positionSizeUSDC: toBigInt(trade[4]).toString(),
      openPrice: toBigInt(trade[5]).toString(),
      buy: trade[6],
      leverage: toBigInt(trade[7]).toString(),
      tp: toBigInt(trade[8]).toString(),
      sl: toBigInt(trade[9]).toString(),
      timestamp: Number(toBigInt(trade[10])),
      additional_info: {
        openInterestUSDC: toBigInt(tradeInfo[0]).toString(),
        tpLastUpdated: toBigInt(tradeInfo[1]).toString(),
        slLastUpdated: toBigInt(tradeInfo[2]).toString(),
        beingMarketClosed: tradeInfo[3],
      },
      marginFee: toBigInt(marginFee).toString(),
      liquidationPrice: toBigInt(liquidationPrice).toString(),
    };

    trades.push(tradeDetails);
  }

  // Process the list of aggregated orders
  for (const aggregatedOrder of result[1]) {
    const [order, liquidationPrice] = aggregatedOrder;

    // Only include orders with valid leverage > 0
    if (toBigInt(order[5]) <= 0n) continue;

    // Extract and format the order data
    const orderDetails = {
      trader: order[0],
      pairIndex: order[1],
      index: order[2],
      positionSize: toBigInt(order[3]).toString(),
      buy: order[4],
      leverage: toBigInt(order[5]).toString(),
      tp: toBigInt(order[6]).toString(),
      sl: toBigInt(order[7]).toString(),
      price: toBigInt(order[8]).toString(),
      slippageP: toBigInt(order[9]).toString(),
      block: toBigInt(order[10]).toString(),
      liquidationPrice: toBigInt(liquidationPrice).toString(),
    };

    pendingOpenLimitOrders.push(orderDetails);
  }

  return { trades, pendingOpenLimitOrders };
}

module.exports = getTrades;
