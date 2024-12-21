const { proceedWithTrade } = require("./proceedwithtrade");


async function handleMarketTrade(bot, msg) {
    try {
      const userSession = await getUserSession(msg.chat.id);
  
      if (!userSession || !userSession.topic || !userSession.address) {
        await bot.sendMessage(msg.chat.id, "Please connect your wallet first using /connect ");
        return;
      }
  
      let tradeState = {
        selectedPair: null,
        size: null,
        leverage: null,
        buy: null,
        price: null,
        stopLoss: null,
        takeProfit: null
      };
  
      const handleLeverageAndStopLoss = async (chatId, maxLeverage) => {
        return new Promise((resolve) => {
          bot.once("message", async (leverageMsg) => {
            const leverage = leverageMsg.text;
            
            if (isNaN(leverage) || parseFloat(leverage) <= 0 || parseFloat(leverage) > maxLeverage) {
              await bot.sendMessage(leverageMsg.chat.id, `Invalid leverage. Please enter a valid number between 1 and ${maxLeverage}x`);
              return;
            }
  
            tradeState.leverage = parseFloat(leverage);
  
            const options = {
              reply_markup: JSON.stringify({
                inline_keyboard: [
                  [{ text: "Yes", callback_data: "set_sl_tp:yes" }],
                  [{ text: "No", callback_data: "set_sl_tp:no" }],
                ],
              }),
            };
  
            await bot.sendMessage(chatId, "Would you like to set Stop Loss and Take Profit?", options);
            resolve();
          });
        });
      };
  
      const handleStopLossInput = async (chatId) => {
        await bot.sendMessage(chatId, "Enter Stop Loss price (or 'skip' to skip):");
        
        return new Promise((resolve) => {
          bot.once("message", async (slMsg) => {
            if (slMsg.text.toLowerCase() === 'skip') {
              tradeState.stopLoss = 0;
              resolve();
              return;
            }
  
            const stopLoss = parseFloat(slMsg.text);
            if (isNaN(stopLoss) || stopLoss <= 0) {
              await bot.sendMessage(chatId, "Invalid Stop Loss. Please enter a valid number or 'skip'.");
              return;
            }
  
            tradeState.stopLoss = stopLoss;
            resolve();
          });
        });
      };
  
      const handleTakeProfitInput = async (chatId) => {
        await bot.sendMessage(chatId, "Enter Take Profit price (or 'skip' to skip):");
        
        return new Promise((resolve) => {
          bot.once("message", async (tpMsg) => {
            if (tpMsg.text.toLowerCase() === 'skip') {
              tradeState.takeProfit = 0;
              resolve();
              return;
            }
  
            const takeProfit = parseFloat(tpMsg.text);
            if (isNaN(takeProfit) || takeProfit <= 0) {
              await bot.sendMessage(chatId, "Invalid Take Profit. Please enter a valid number or 'skip'.");
              return;
            }
  
            tradeState.takeProfit = takeProfit;
            resolve();
          });
        });
      };
  
      showPairsMenu(bot, msg.chat.id, "market");
  
      bot.once("callback_query", async (callbackQuery) => {
        const { data, message } = callbackQuery;
        const [action, type, selectedPair] = data.split(":");
  
        if (action !== "select_pair" || type !== "market") {
          await bot.sendMessage(message.chat.id, "Invalid selection. Please try again.");
          return;
        }
  
        tradeState.selectedPair = selectedPair;
        tradeState.price = await price({ id: [feedIds[selectedPair].id] });
        const maxLeverage = feedIds[selectedPair].leverage || "NaN";
  
        const options = {
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [{ text: "Long 🟢", callback_data: `trade_direction:long:${selectedPair}` }],
              [{ text: "Short 🔴", callback_data: `trade_direction:short:${selectedPair}` }],
            ],
          }),
        };
  
        await bot.sendMessage(message.chat.id, "Do you want to go Long🟢 or Short🔴?", options);
  
        bot.once("callback_query", async (directionCallback) => {
          const directionData = directionCallback.data.split(":");
          const direction = directionData[1];
          tradeState.buy = direction === "long";
  
          await bot.sendMessage(directionCallback.message.chat.id, `You selected ${tradeState.buy ? "Long 🟢" : "Short 🔴"}. Enter the size in USDC:`);
  
          bot.once("message", async (sizeMsg) => {
            const size = sizeMsg.text;
  
            if (isNaN(size) || parseFloat(size) <= 0) {
              await bot.sendMessage(sizeMsg.chat.id, "Invalid size. Please enter a valid number.");
              return;
            }
  
            try {
              const check_balance = await CONTRACT_INSTANCE_USDC.balanceOf(userSession.address);
              const check_allowance = await CONTRACT_INSTANCE_USDC.allowance(userSession.address, SPENDER_APPROVE);
              const requiredAmount = ethers.parseUnits(size.toString(), 6);
              
              tradeState.size = parseFloat(size);
  
              if (check_balance < requiredAmount) {
                await bot.sendMessage(sizeMsg.chat.id, 
                  `Insufficient balance!\n` +
                  `Available Balance: ${ethers.formatUnits(check_balance, 6)} USDC\n` +
                  `Required Amount: ${size} USDC`
                );
                return;
              }
  
              if (check_allowance < requiredAmount) {
                const neededApproval = ethers.formatUnits(requiredAmount - check_allowance, 6);
                
                const approveOptions = {
                  reply_markup: JSON.stringify({
                    inline_keyboard: [
                      [{ text: "Approve USDC", callback_data: `approve:${neededApproval}` }],
                      [{ text: "Cancel", callback_data: "approve:cancel" }],
                    ],
                  }),
                };
  
                await bot.sendMessage(sizeMsg.chat.id, 
                  `Additional approval needed: ${neededApproval} USDC\n` +
                  `Current Allowance: ${ethers.formatUnits(check_allowance, 6)} USDC\n` +
                  `Click below to approve:`, 
                  approveOptions
                );
  
                bot.once("callback_query", async (approveCallback) => {
                  const [action, value] = approveCallback.data.split(":");
                  
                  if (action === "approve" && value !== "cancel") {
                    const approveMsg = {
                      chat: { id: sizeMsg.chat.id },
                      text: `/approve ${value}`
                    };
  
                    const approvalSuccess = await handleApprove(bot, approveMsg);
                    
                    if (!approvalSuccess) {
                      await bot.sendMessage(sizeMsg.chat.id, "Approval failed or was rejected. Please try again /openmarket");
                      return;
                    }
  
                    await bot.sendMessage(sizeMsg.chat.id, 
                      `Size: ${size} USDC. Now enter leverage:\nMax leverage for this pair is ${maxLeverage}x`
                    );
                    
                    await handleLeverageAndStopLoss(sizeMsg.chat.id, maxLeverage);
                  } else {
                    await bot.sendMessage(sizeMsg.chat.id, "Trade cancelled. Use /openmarket to start again.");
                    return;
                  }
                });
  
              } else {
                await bot.sendMessage(sizeMsg.chat.id, 
                  `Size: ${size} USDC. Now enter leverage:\nMax leverage for this pair is ${maxLeverage}x`
                );
                
                await handleLeverageAndStopLoss(sizeMsg.chat.id, maxLeverage);
              }
  
              // Handle Stop Loss and Take Profit selection
              bot.once("callback_query", async (slTpCallback) => {
                const [action, value] = slTpCallback.data.split(":");
                
                if (action === "set_sl_tp" && value === "yes") {
                  await handleStopLossInput(sizeMsg.chat.id);
                  await handleTakeProfitInput(sizeMsg.chat.id);
                }
  
                // Proceed with trade after all parameters are set
                if (tradeState.selectedPair && tradeState.size && tradeState.leverage) {
                  await proceedWithTrade(
                    bot, 
                    sizeMsg.chat.id, 
                    tradeState.selectedPair, 
                    tradeState.size, 
                    tradeState.leverage, 
                    tradeState.price, 
                    tradeState.buy, 
                    tradeState.stopLoss || 0, 
                    tradeState.takeProfit || 0
                  );
                }
              });
  
            } catch (error) {
              console.error("Trade processing error:", error);
              await bot.sendMessage(sizeMsg.chat.id, "Error processing trade. Please try again.");
            }
          });
        });
      });
  
    } catch (error) {
      console.error("Handle market trade error:", error);
      await bot.sendMessage(msg.chat.id, "Failed to open Market trade. Please try again.");
    }
  }

//   async function proceedWithTrade(bot, chatId, selectedPair, size, leverage, Price, buy, stopLoss, takeProfit) {
//     try {
//       const userSession = await getUserSession(chatId);
  
//       // Calculate adjusted stop-loss
//       const adjustedStopLoss = (calculateStopLoss(Price, stopLoss, leverage, buy)).toFixed(3);
      
//       const tradeParams = {
//         trader: userSession.address,
//         pairIndex: PAIRS_OBJECT[selectedPair],
//         index: 0,
//         initialPosToken: 0,
//         positionSizeUSDC: ethers.parseUnits(size, 6),
//         openPrice: ethers.parseUnits(Price, 10),
//         buy: buy,
//         leverage: ethers.parseUnits(leverage, 10),
//         tp: takeProfit ? ethers.parseUnits(takeProfit.toString(), 10) : 0,
//         sl: stopLoss ? ethers.parseUnits(adjustedStopLoss.toString(), 10) : 0,
//         timestamp: Math.floor(Date.now() / 1000),
//       };
  
//       const type = 0; // Market order
//       const slippageP = ethers.parseUnits("1", 10); // 0.3%
//       const executionFee = 0;
  
//       // Encode the function call
//       const iface = new ethers.Interface(TRADING_ABI);
//       const data = iface.encodeFunctionData("openTrade", [
//         [
//           tradeParams.trader,
//           tradeParams.pairIndex,
//           tradeParams.index,
//           tradeParams.initialPosToken,
//           tradeParams.positionSizeUSDC,
//           tradeParams.openPrice,
//           tradeParams.buy,
//           tradeParams.leverage,
//           tradeParams.tp,
//           tradeParams.sl,
//           tradeParams.timestamp,
//         ],
//         type,
//         slippageP,
//         executionFee,
//       ]);
  
//       await bot.sendMessage(
//         chatId,
//         `Approve Trade in your wallet...`
//       );
  
//       // Send transaction request
//       const { result } = await makeWalletConnectRequest(`/request/${userSession.topic}`, "POST", {
//         chainId: `eip155:${BASE_CHAIN_ID}`,
//         request: {
//           method: "eth_sendTransaction",
//           params: [
//             {
//               from: userSession.address,
//               to: CONTRACT_ADDRESS_TRADING,
//               data: data,
//               value: "0x0",
//             },
//           ],
//         },
//       });
  
//       // Initial message about transaction submission
//       const initialMessage = await bot.sendMessage(
//         chatId,
//         `Trade transaction submitted! Hash: ${result}\nWaiting for blockchain confirmation...`
//       );
  
//       // Wait for blockchain confirmations
//       let confirmations = 0;
//       const maxWaitTime = 5 * 60 * 1000; // 5 minutes
//       const startTime = Date.now();
  
//       const checkConfirmations = async () => {
//         try {
//           // Use a longer timeout for L2 chains
//           const maxWaitTime = 10 * 60 * 1000; // 10 minutes instead of 5
      
//           // Try to get receipt multiple times
//           let receipt = null;
//           for (let attempt = 0; attempt < 5; attempt++) {
//             receipt = await Provider.getTransactionReceipt(result);
//             if (receipt) break;
//             await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between attempts
//           }
      
//           if (!receipt) {
//             console.log('No receipt found after multiple attempts');
            
//             // Check transaction exists using getTransaction
//             const tx = await Provider.getTransaction(result);
//             if (tx) {
//               console.log('Transaction exists but no receipt yet');
//             } else {
//               console.error('Transaction not found');
//             }
      
//             // Continue checking if within timeout
//             if (Date.now() - startTime < maxWaitTime) {
//               setTimeout(checkConfirmations, 15000);
//               return;
//             }
//           }
      
//           // Check transaction status explicitly
//           if (receipt) {
//             console.log('Receipt Status:', receipt.status);
//             console.log('Block Number:', receipt.blockNumber);
      
//             // For L2, you might want to reduce confirmation requirements
//             if (receipt.status === 1) {
//               await bot.editMessageText(
//                 `Trade confirmed on blockchain! ✅\n` +
//                 `Transaction Hash: ${result}\n` +
//                 `Block Number: ${receipt.blockNumber}`,
//                 {
//                   chat_id: chatId,
//                   message_id: initialMessage.message_id
//                 }
//               );
      
//               // Store trade
//               const mockOrderId = Date.now().toString();
//               await storeTrade(chatId, mockOrderId, result);
      
//               return true;
//             }
//           }
      
//           // Continue checking if within timeout
//           if (Date.now() - startTime < maxWaitTime) {
//             setTimeout(checkConfirmations, 15000);
//           } else {
//             await bot.editMessageText(
//               `Trade submission timed out. Please check transaction status manually.\n` +
//               `Transaction Hash: ${result}`,
//               {
//                 chat_id: chatId,
//                 message_id: initialMessage.message_id
//               }
//             );
//           }
//         } catch (error) {
//           console.error("Confirmation check error:", error);
          
//           // Detailed L2-specific error logging
//           console.log('Error Details:', {
//             name: error.name,
//             code: error.code,
//             message: error.message,
//           });
      
//           await bot.editMessageText(
//             `Error checking transaction on L2.\n` +
//             `Transaction Hash: ${result}\n` +
//             `Error: ${error.message}`,
//             {
//               chat_id: chatId,
//               message_id: initialMessage.message_id
//             }
//           );
//         }
//       };
//       // Start confirmation checking
//       await checkConfirmations();
  
//     } catch (error) {
//       console.error("Open trade error:", error.message);
//       await bot.sendMessage(chatId, `Failed to open trade. Error: ${error}`);
//     }
//   }
  
  

  module.exports = {handleMarketTrade}