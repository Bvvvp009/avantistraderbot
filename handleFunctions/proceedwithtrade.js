async function proceedWithTrade(bot, chatId, selectedPair, size, leverage, Price, buy, stopLoss, takeProfit) {
    try {
      const userSession = await getUserSession(chatId);
  
      // Calculate adjusted stop-loss
      const adjustedStopLoss = (calculateStopLoss(Price, stopLoss, leverage, buy)).toFixed(3);
      
      const tradeParams = {
        trader: userSession.address,
        pairIndex: PAIRS_OBJECT[selectedPair],
        index: 0,
        initialPosToken: 0,
        positionSizeUSDC: ethers.parseUnits(size, 6),
        openPrice: ethers.parseUnits(Price, 10),
        buy: buy,
        leverage: ethers.parseUnits(leverage, 10),
        tp: takeProfit ? ethers.parseUnits(takeProfit.toString(), 10) : 0,
        sl: stopLoss ? ethers.parseUnits(adjustedStopLoss.toString(), 10) : 0,
        timestamp: Math.floor(Date.now() / 1000),
      };
  
      const type = 0; // Market order
      const slippageP = ethers.parseUnits("1", 10); // 0.3%
      const executionFee = 0;
  
      // Encode the function call
      const iface = new ethers.Interface(TRADING_ABI);
      const data = iface.encodeFunctionData("openTrade", [
        [
          tradeParams.trader,
          tradeParams.pairIndex,
          tradeParams.index,
          tradeParams.initialPosToken,
          tradeParams.positionSizeUSDC,
          tradeParams.openPrice,
          tradeParams.buy,
          tradeParams.leverage,
          tradeParams.tp,
          tradeParams.sl,
          tradeParams.timestamp,
        ],
        type,
        slippageP,
        executionFee,
      ]);
  
      await bot.sendMessage(
        chatId,
        `Approve Trade in your wallet...`
      );
  
      // Send transaction request
      const { result } = await makeWalletConnectRequest(`/request/${userSession.topic}`, "POST", {
        chainId: `eip155:${BASE_CHAIN_ID}`,
        request: {
          method: "eth_sendTransaction",
          params: [
            {
              from: userSession.address,
              to: CONTRACT_ADDRESS_TRADING,
              data: data,
              value: "0x0",
            },
          ],
        },
      });
  
      // Initial message about transaction submission
      const initialMessage = await bot.sendMessage(
        chatId,
        `Trade transaction submitted! Hash: ${result}\nWaiting for blockchain confirmation...`
      );
  
      // Wait for blockchain confirmations
      let confirmations = 0;
      const maxWaitTime = 5 * 60 * 1000; // 5 minutes
      const startTime = Date.now();
  
      const checkConfirmations = async () => {
        try {
          // Use a longer timeout for L2 chains
          const maxWaitTime = 10 * 60 * 1000; // 10 minutes instead of 5
      
          // Try to get receipt multiple times
          let receipt = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            receipt = await Provider.getTransactionReceipt(result);
            if (receipt) break;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between attempts
          }
      
          if (!receipt) {
            console.log('No receipt found after multiple attempts');
            
            // Check transaction exists using getTransaction
            const tx = await Provider.getTransaction(result);
            if (tx) {
              console.log('Transaction exists but no receipt yet');
            } else {
              console.error('Transaction not found');
            }
      
            // Continue checking if within timeout
            if (Date.now() - startTime < maxWaitTime) {
              setTimeout(checkConfirmations, 15000);
              return;
            }
          }
      
          // Check transaction status explicitly
          if (receipt) {
            console.log('Receipt Status:', receipt.status);
            console.log('Block Number:', receipt.blockNumber);
      
            // For L2, you might want to reduce confirmation requirements
            if (receipt.status === 1) {
              await bot.editMessageText(
                `Trade confirmed on blockchain! ✅\n` +
                `Transaction Hash: ${result}\n` +
                `Block Number: ${receipt.blockNumber}`,
                {
                  chat_id: chatId,
                  message_id: initialMessage.message_id
                }
              );
      
              // Store trade
              const mockOrderId = Date.now().toString();
              await storeTrade(chatId, mockOrderId, result);
      
              return true;
            }
          }
      
          // Continue checking if within timeout
          if (Date.now() - startTime < maxWaitTime) {
            setTimeout(checkConfirmations, 15000);
          } else {
            await bot.editMessageText(
              `Trade submission timed out. Please check transaction status manually.\n` +
              `Transaction Hash: ${result}`,
              {
                chat_id: chatId,
                message_id: initialMessage.message_id
              }
            );
          }
        } catch (error) {
          console.error("Confirmation check error:", error);
          
          // Detailed L2-specific error logging
          console.log('Error Details:', {
            name: error.name,
            code: error.code,
            message: error.message,
          });
      
          await bot.editMessageText(
            `Error checking transaction on L2.\n` +
            `Transaction Hash: ${result}\n` +
            `Error: ${error.message}`,
            {
              chat_id: chatId,
              message_id: initialMessage.message_id
            }
          );
        }
      };
      // Start confirmation checking
      await checkConfirmations();
  
    } catch (error) {
      console.error("Open trade error:", error.message);
      await bot.sendMessage(chatId, `Failed to open trade. Error: ${error}`);
    }
  }
  
module.exports = {proceedWithTrade}