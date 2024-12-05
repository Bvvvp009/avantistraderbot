const { ethers } = require("ethers");
const getTrades = require("./getTrades"); // Assuming getTrades is imported
const pairsMapping = require('./info.json')
const pairs_array = require('./pairs')

async function handleGetTrades(bot, msg, contractInstance) {
  const chatId = msg.chat.id;

  // Fetch user session from your database
  const userSession = await getUserSession(chatId);
  if (!userSession || !userSession.address) {
    await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
    return;
  }

  const traderAddress = userSession.address;

  try {
    // Fetch trades and pending orders
    const { trades, pendingOpenLimitOrders } = await getTrades(traderAddress, contractInstance);

    if (trades.length === 0 && pendingOpenLimitOrders.length === 0) {
      await bot.sendMessage(chatId, "You have no open trades or pending orders.");
      return;
    }

    // Display open trades
    if (trades.length > 0) {
      for (const trade of trades) {
        const pairName = pairs_array[parseInt((trade.pairIndex).toString())] || "Unknown Pair";

        const tradeMessage = `
        **Open Trade:**
        - Pair: ${pairName}
        - Position Size (USDC): ${ethers.formatUnits(trade.positionSizeUSDC, 6)}
        - Leverage: ${ethers.formatUnits(trade.leverage, 10)}x
        - Open Price: ${ethers.formatUnits(trade.openPrice, 10)}
        - Take Profit: ${ethers.formatUnits(trade.tp, 10)}
        - Stop Loss: ${ethers.formatUnits(trade.sl, 10)}
        - Liquidation Price: ${ethers.formatUnits(trade.liquidationPrice, 10)}
                `;

        await bot.sendMessage(chatId, tradeMessage, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Close ❌",
                  callback_data: `close_trade:${trade.pairIndex}:${trade.index}`,
                },
              ],
            ],
          },
        });
      }
    }

    // Display pending limit orders
    if (pendingOpenLimitOrders.length > 0) {
      for (const order of pendingOpenLimitOrders) {
        const pairName = Object.keys(pairsMapping).find(key => pairsMapping[key] === order.pairIndex) || "Unknown Pair";

        const orderMessage = `
**Pending Order:**
- Pair: ${pairName}
- Position Size: ${ethers.formatUnits(order.positionSize, 6)}
- Leverage: ${ethers.formatUnits(order.leverage, 10)}x
- Price: ${ethers.formatUnits(order.price, 10)}
- Take Profit: ${ethers.formatUnits(order.tp, 10)}
- Stop Loss: ${ethers.formatUnits(order.sl, 10)}
        `;

        await bot.sendMessage(chatId, orderMessage);
      }
    }
  } catch (error) {
    console.error("Error fetching trades:", error);
    await bot.sendMessage(chatId, "Failed to fetch trades. Please try again later.");
  }
}

// Handle trade close callback
async function handleTradeCloseCallback(bot, query, contractInstance) {
  const chatId = query.message.chat.id;
  const callbackData = query.data.split(":");
  const pairIndex = parseInt(callbackData[1], 10);
  const tradeIndex = parseInt(callbackData[2], 10);

  try {
    // Execution fee (you may replace this with dynamic calculation if needed)
    const executionFee = ethers.parseUnits("0.01", "ether");

    // Send the transaction to close the trade
    const tx = await contractInstance.closeTradeMarket(pairIndex, tradeIndex, 0, executionFee);
    await tx.wait();

    await bot.answerCallbackQuery(query.id, { text: "Trade closed successfully!" });
    await bot.sendMessage(chatId, `Trade for pair index ${pairIndex} closed successfully.`);
  } catch (error) {
    console.error("Error closing trade:", error);
    await bot.answerCallbackQuery(query.id, { text: "Failed to close trade. Try again later." });
  }
}

module.exports = { handleGetTrades, handleTradeCloseCallback };
