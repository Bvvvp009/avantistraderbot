const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const dotenv = require('dotenv');
const { ethers,Contract } = require('ethers');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const fs = require('fs');
const {PriceServiceConnection} = require('@pythnetwork/price-service-client')
const PAIRS_OBJECT = require('./constants/pairs/pairsindex.json') 
const feedIds = require('./constants/feed_pairs_contracts/feedIds.json');
const Contracts = require('./constants/feed_pairs_contracts/contracts.json');
const getTrades = require('./trades/getTrades');
// ABI fragment for openTrade function
const TRADING_ABI = require('./constants/abis/tradingabi.json');
const ALL_PAIRS = require('./constants/feed_pairs_contracts/pairs.json');
const pairs_with_index_number = require('./constants/pairs/pairsinformation.json');
const {calculateStopLoss} = require('./trades/sl_tp');
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WALLET_CONNECT_SERVICE_URL = process.env.WALLET_CONNECT_SERVICE_URL || 'http://localhost:3000';
const BASE_RPC = process.env.BASE_RPC
const CONTRACT_ADDRESS_TRADING = '0x5FF292d70bA9cD9e7CCb313782811b3D7120535f';
const BASE_CHAIN_ID = 8453;
const USDC_CONTRACT_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPENDER_APPROVE = "0x8a311D7048c35985aa31C131B9A13e03a5f7422d"

const USDC_ABI = JSON.parse(fs.readFileSync('./constants/abis/erc20abi.json'));
const MULTICALL_ABI = JSON.parse(fs.readFileSync('./constants/abis/multicall.json'));
const Provider = new ethers.JsonRpcProvider(BASE_RPC)
const CONTRACT_INSTANCE_USDC = new Contract(USDC_CONTRACT_ON_BASE,USDC_ABI,Provider);
const CONTRACT_INSTANCE_MULTICALL = new Contract(Contracts["Multicall"],MULTICALL_ABI,Provider);
const  CONTRACT_INSTANCE_TRADING  = new Contract(CONTRACT_ADDRESS_TRADING,TRADING_ABI,Provider);

//Initialize DataBase
const db = new sqlite3.Database('users_sessions.db');





async function initDatabase() {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run(`
          CREATE TABLE IF NOT EXISTS user_sessions (
            chat_id INTEGER PRIMARY KEY,
            topic TEXT,
            address TEXT,
            session_data TEXT
          )
        `, (err) => {
          if (err) reject(err);
        });
  
      
        db.run(`
          CREATE TABLE IF NOT EXISTS trades (
            chat_id INTEGER,
            order_id TEXT,
            timestamp INTEGER,
            tx_hash TEXT,
            PRIMARY KEY (chat_id, order_id)
          )
        `, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }

async function makeWalletConnectRequest(endpoint, method = 'GET', data = null) {
  try {
    const response = await axios({
      method,
      url: `${WALLET_CONNECT_SERVICE_URL}${endpoint}`,
      data,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`WalletConnect service error (${endpoint}):`, error.response?.data || error.message);
    throw error;
  }
}


async function initBot() {
  try {
  
    await initDatabase();
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  
    bot.onText(/\/start/, (msg) => handleStart(bot, msg));
    bot.onText(/\/connect/, (msg) => handleConnect(bot, msg));
    bot.onText(/\/openlimit/, (msg) => handleLimitTrade(bot, msg));
    bot.onText(/\/trades/, (msg) => handleViewTrades(bot, msg));
    bot.onText(/\/openmarket/, (msg) => handleMarketTrade(bot, msg));
    bot.onText(/\/verify/, (msg) => handleVerifyConnection(bot, msg));
    bot.onText(/\/opentrades/, (msg) => handleGetTrades(bot, msg, CONTRACT_INSTANCE_MULTICALL));
    bot.onText(/\/disconnect/, (msg) => handleDisconnect(bot, msg));
   // Handle the initial /approve command
bot.onText(/^\/approve$/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    "💰 Please enter the amount you want to approve.\nFormat: `/approve amount`",
    { parse_mode: "Markdown" }
  );
});

// Handle the /approve command with amount
bot.onText(/^\/approve\s+(\d+(?:\.\d+)?)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const amount = match[1];

  try {
    await handleApprove(bot, msg);
    await bot.sendMessage(chatId, `✅ Approved ${amount} USDC for spending.`);
  } catch (error) {
    console.error("Error during approval:", error);
    await bot.sendMessage(chatId, "❌ Failed to process approval. Please try again.");
  }
});
  
    await bot.setMyCommands([
      { command: '/start', description: 'Start the bot' },
      { command: '/connect', description: 'Connect your wallet' },
      { command: '/verify', description: 'Verify wallet connection' },
      { command: '/openlimit', description: 'Open a new Limit order for selected pair' },
      { command: '/opentrades', description: 'View your recent trades' },
      { command: '/approve', description: 'Approve spending limit of Contract (e.g., /approve 100)' },
      { command: '/openmarket', description: 'Open a Market trade for the selected pair' },
      { command: '/disconnect', description: 'Disconnects wallet session.' },
    ]);
    
      bot.on("callback_query", async (query) => {
        if (query.data.startsWith("close_trade:")) {
        await handleTradeCloseCallback(bot, query, CONTRACT_INSTANCE_TRADING);
        }
      });

      bot.on("callback_query", async (query) => {
        if (query.data.startsWith("close_limit_trade:")) {
        await handleTradeCloseCallback_limit(bot, query, CONTRACT_INSTANCE_TRADING);
        }
      });

      bot.on("callback_query", async (callbackQuery) => {
        const { data, message } = callbackQuery;
        const [action, pairIndex, tradeIndex, positionSize] = data.split(":");
      
        if (action === "close_partial") {
          await bot.sendMessage(message.chat.id, `You selected to partially close your position on ${pairs_with_index_number[pairIndex]}. 
            💼 Current Position Size: ${positionSize} USDC
            🔢 Please enter the size to close:`);
      
          bot.once("message", async (sizeMsg) => {
            const partialSize = sizeMsg.text;
      
            if (isNaN(partialSize) || parseFloat(partialSize) <= 0 || parseFloat(partialSize) > parseFloat(positionSize)) {
              await bot.sendMessage(sizeMsg.chat.id, "Invalid size. Please enter a valid number less than or equal to your position size.");
              return;
            }
      
            try {
              // Call your function to process the partial close
              await handleTradeCloseCallback(bot, callbackQuery, CONTRACT_INSTANCE_TRADING,partialSize);

              await bot.sendMessage(sizeMsg.chat.id, `✅ Successfully submitted request to close ${partialSize} USDC of your position.`);
            } catch (error) {
              console.error("Error during partial close:", error);
              await bot.sendMessage(sizeMsg.chat.id, "❌ Failed to process partial close. Please try again later.");
            }
          });
        }
      });
    } catch (error) {
      console.log(error)
    }
  }

  
  function showPairsMenu(bot, chatId, orderType) {
    const inlineKeyboard = [];
    
    // Group pairs into rows of 3
    for (let i = 0; i < ALL_PAIRS.length; i += 4) {
      const row = ALL_PAIRS.slice(i, i + 4).map((pair) => ({
        text: pair,
        callback_data: `select_pair:${orderType}:${pair}`,
      }));
      inlineKeyboard.push(row);
    }
  
    bot.sendMessage(chatId, 'Please select a trading pair:', {
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    });
  }
  
  
  async function handleStart(bot, msg) {
    const welcomeMessage =
      'Welcome to the WalletConnect Bot! 🤖\n\n' +
      'Use /connect to connect your wallet\n' +
      'Use /verify to check wallet connection is still active\n'+
      'Use /approve <amount> to approve spending amount\n'+
      'Use /openmarket <pair> <size> <leverage>  to open a Market Trade\n'+
      'Use /openlimit <pair> <size> <leverage>  to open a Limit Trade\n'+
      'Use /opentrades to view your recent trades'

    await bot.sendMessage(msg.chat.id, welcomeMessage);
  }
  
  async function handleDisconnect(bot,msg) {
    try {
      const existingSession = await getUserSession(msg.chat.id);
      if (existingSession && existingSession.topic) {
        try {
          const session = await makeWalletConnectRequest(`/session/${existingSession.topic}`, 'DELETE');
          console.log(session)
          if(session.success=true){
            await bot.sendMessage(
              msg.chat.id,
              `Your wallet session has been disconnected.  
            To start a new session, please use the /connect command.`
            );
                      }
        } catch (error) {
          console.log('Error disconnecting existing session:', error);
        }
      }
    } catch (error) {
      await bot.sendMessage(msg.chat.id, 'Error occured while disconnecting try again.');
    }
  }
  async function handleConnect(bot, msg) {
    try {
      const existingSession = await getUserSession(msg.chat.id);
      if (existingSession && existingSession.topic) {
        try {
          await makeWalletConnectRequest(`/session/${existingSession.topic}`, 'DELETE');
        } catch (error) {
          console.log('Error disconnecting existing session:', error);
        }
      }
  
      // Request new connection
      const { uri, topic } = await makeWalletConnectRequest('/connect', 'POST');

        if (uri) {
          // Generate QR Code
          const qrCodeImage = await QRCode.toBuffer(uri);        
          // Base redirect URL
          const baseRedirectUrl = 'https://bvvvp009.github.io/wallet-connect-reconnect/redirect.html';
        
          // Wallet-specific redirect links
          const walletLinks = [
            {
              name: 'MetaMask',
              redirectScheme: 'metamask',
              icon: '🦊',
            },
            {
              name: 'Trust Wallet',
              redirectScheme: 'trust',
              icon: '🛡',
            },
            {
              name: 'Other wallets',
              redirectScheme: 'safe',
              icon: '👜',
            },
          ];
        
          // Create clickable wallet connection links using redirect
          const walletLinksText = walletLinks
            .map(
              (wallet) =>
                `${wallet.icon} [Connect with ${wallet.name}](${baseRedirectUrl}?wallet=${wallet.redirectScheme}&uri=${encodeURIComponent(
                  uri
                )})`
            )
            .join('\n');
        
          // Escape Markdown for raw URI
          function escapeMarkdown(text) {
            return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
          }
        
          const escapedUri = escapeMarkdown(uri);
        
          // Send the message with QR code, redirect links, and raw URI
          await bot.sendPhoto(msg.chat.id, qrCodeImage, {
            caption:
              `Scan the QR Code or Quick Connect:\n\n` +
              `${walletLinksText}\n\n` +
              `OR directly paste this URI in your wallet:\n\`${escapedUri}\``,
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: walletLinks.map((wallet) => [
                {
                  text: `${wallet.icon} Connect ${wallet.name}`,
                  url: `${baseRedirectUrl}?wallet=${wallet.redirectScheme}&uri=${encodeURIComponent(
                    uri
                  )}`,
                },
              ]),
            },
          });
          
          const statusMessage = await bot.sendMessage(
            msg.chat.id,
          `Please select a wallet to connect.\n` +
          `This session will remain active for only 1 minute.\n`+  
          `If this session expire, you can restart it anytime use /connect command.`
          );
          

        // Poll for session status
        const maxAttempts = 30; // 1 minute timeout
        let attempts = 0;
        
        while (attempts < maxAttempts) {
          try {
            const statusResponse = await makeWalletConnectRequest(`/session-status/${topic}`, 'GET');
            
            if (statusResponse.status === 'connected') {
              // Get session details using the final topic
              const { session } = await makeWalletConnectRequest(`/session/${statusResponse.topic}`, 'GET');
              const address = session.namespaces.eip155.accounts[0].split(':')[2];
              
              await saveUserSession(
                msg.chat.id, 
                statusResponse.topic, 
                address,
                JSON.stringify(session)
              );
  
              await bot.editMessageText(
                `Wallet connected successfully!\nAddress: ${address}\nYou can now use /openmarket to place orders.`,
                {
                  chat_id: msg.chat.id,
                  message_id: statusMessage.message_id
                }
              );
              return;
            } else if (statusResponse.status === 'failed') {
              await bot.editMessageText(
                'Connection failed. Please try again.',
                {
                  chat_id: msg.chat.id,
                  message_id: statusMessage.message_id
                }
              );
              return;
            }
          } catch (error) {
            console.error('Status check error:', error);
          }
  
          await new Promise(resolve => setTimeout(resolve, 3000));
          attempts++;
        }
  
        await bot.editMessageText(
          'Connection timeout. Please try again.',
          {
            chat_id: msg.chat.id,
            message_id: statusMessage.message_id
          }
        );
      }
    } catch (error) {
      console.error('Connection error:', error);
      await bot.sendMessage(msg.chat.id, 'Failed to connect wallet. Please try again.');
    }
  }

  async function handleVerifyConnection(bot,msg) {
    // Verify session is still active

    const userSession = await getUserSession(msg.chat.id);

    try {
      const {session} = await makeWalletConnectRequest(`/session/${userSession.topic}`, 'GET');
      if (session){
         await bot.sendMessage(msg.chat.id,`Session found`)
      }
    } catch (error) {
      await bot.sendMessage(msg.chat.id, 'Your wallet session has expired. Please reconnect using /connect');
      return;
    }
  }

  async function handleApprove(bot, msg, tradeState = null) {
    const [, amount] = msg.text.split(' ');
  
    if (!amount) {
      await bot.sendMessage(msg.chat.id, 'Please provide amount to spend: /approve <amount>');
      return false;
    }
  
    try {
      const userSession = await getUserSession(msg.chat.id);
      if (!userSession || !userSession.topic || !userSession.address) {
        await bot.sendMessage(msg.chat.id, 'Please connect your wallet first using /connect');
        return false;
      }
  
      const currentAllowance = await CONTRACT_INSTANCE_USDC.allowance(userSession.address, SPENDER_APPROVE);
      console.log(`Current Allowance: ${ethers.formatUnits(currentAllowance, 6)} USDC`);
  
      try {
        await makeWalletConnectRequest(`/session/${userSession.topic}`, 'GET');
      } catch (error) {
        await bot.sendMessage(msg.chat.id, 'Your wallet session has expired. Please reconnect using /connect');
        return false;
      }
  
      const parseAmount = parseFloat(amount);
      if (isNaN(parseAmount) || parseAmount <= 0) {
        await bot.sendMessage(msg.chat.id, 'Invalid amount. Please enter a positive number.');
        return false;
      }
  
      const userBalance = await CONTRACT_INSTANCE_USDC.balanceOf(userSession.address);
      const requestedAllowance = ethers.parseUnits(amount.toString(), 6);

      if (userBalance < requestedAllowance) {
        await bot.sendMessage(msg.chat.id, 
          `Insufficient USDC balance!\n` +
          `Current Balance: ${ethers.formatUnits(userBalance, 6)} USDC\n` +
          `Requested Allowance: ${amount} USDC\n` +
          `Current Allowance: ${ethers.formatUnits(currentAllowance, 6)} USDC`
        );
        return false;
      }
  
      const approveParams = {
        spender: SPENDER_APPROVE,
        allowance: requestedAllowance
      };
      
      const iface = new ethers.Interface(USDC_ABI);
      const data = iface.encodeFunctionData("approve", [
        approveParams.spender,
        approveParams.allowance
      ]);
  
      const initialMessage = await bot.sendMessage(msg.chat.id, 
        `Requesting approval for ${amount} USDC\n` +
        `Spender: ${SPENDER_APPROVE}\n` +
        'Please check your wallet for approval...'
      );
  
      const { result } = await makeWalletConnectRequest(`/request/${userSession.topic}`, 'POST', {
        chainId: `eip155:${BASE_CHAIN_ID}`,
        request: {
          method: 'eth_sendTransaction',
          params: [{
            from: userSession.address,
            to: USDC_CONTRACT_ON_BASE,
            data: data,
            value: '0x0'
          }],
        },
      });
  
      const maxWaitTime = 2 * 60 * 1000;
      const startTime = Date.now();
  
      return new Promise((resolve) => {
        const checkConfirmations = async () => {
          try {
            const receipt = await Provider.getTransactionReceipt(result);
        
            if (receipt) {
              const currentBlock = await Provider.getBlockNumber();
              const confirmations = currentBlock - receipt.blockNumber;
        
              if (confirmations >= 3) {
                const newAllowance = await CONTRACT_INSTANCE_USDC.allowance(userSession.address, SPENDER_APPROVE);
        
                await bot.editMessageText(
                  `Approval Confirmed! ✅\n` +
                  `Transaction Hash: ${result}\n` +
                  `Confirmations: ${confirmations}\n` +
                  `New Allowance: ${ethers.formatUnits(newAllowance, 6)} USDC`,
                  {
                    chat_id: msg.chat.id,
                    message_id: initialMessage.message_id
                  }
                );

                // If we have tradeState, continue with the trade

                console.log(tradeState)
                if (tradeState) {
                  await bot.sendMessage(msg.chat.id, 
                    `Approval successful! Continuing with your ${tradeState.buy ? "Long 🟢" : "Short 🔴"} position...\n` +
                    `Please enter leverage (Max: ${tradeState.maxLeverage}x):`
                  );
                }
        
                resolve(true);
                return;
              }
            }
        
            if (Date.now() - startTime < maxWaitTime) { 
              setTimeout(checkConfirmations, 5000);
            } else {
              await bot.editMessageText(
                `Approval transaction timed out. Please try again.\n` +
                `Transaction Hash: ${result}`,
                {
                  chat_id: msg.chat.id,
                  message_id: initialMessage.message_id
                }
              );
              resolve(false);
            }
          } catch (error) {
            console.error("Confirmation check error:", error);
            resolve(false);
          }
        };
        
        checkConfirmations();
      });
  
    } catch (error) {
      console.error("Approve transaction error:", error);
      await bot.sendMessage(msg.chat.id, `Failed to process approval. Error: ${error.message || ''}`);
      return false;
    }
}


// handleLimitTrade function
async function handleLimitTrade(bot, msg) {
  try {
    const userSession = await getUserSession(msg.chat.id);

    if (!userSession || !userSession.topic || !userSession.address) {
      await bot.sendMessage(msg.chat.id, "Please connect your wallet first using /connect");
      return;
    }

    let tradeState = {
      selectedPair: null,
      size: null,
      leverage: null,
      buy: null,
      price: null,
      limitPrice: null,
      stopLoss: null,
      takeProfit: null
    };

    showPairsMenu(bot, msg.chat.id, "limit");

    bot.once("callback_query", async (callbackQuery) => {
      const { data, message } = callbackQuery;
      const [action, type, selectedPair] = data.split(":");

      if (action !== "select_pair" || type !== "limit") {
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
                    [{ text: "📝 Approve USDC", callback_data: `approve:${neededApproval}` }],
                    [{ text: "❌ Cancel", callback_data: "approve:cancel" }],
                  ],
                }),
              };

              await bot.sendMessage(sizeMsg.chat.id, 
                `⚠️ Insufficient Approval!\n\n` +
                `Current Allowance: ${ethers.formatUnits(check_allowance, 6)} USDC\n` +
                `Required Amount: ${size} USDC\n` +
                `Additional Needed: ${neededApproval} USDC`, 
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
                    await bot.sendMessage(sizeMsg.chat.id, "Approval failed or was rejected. Please try again /openlimit");
                    return;
                  }

                  await continueLimitTradeFlow(bot, sizeMsg.chat.id, tradeState, maxLeverage);
                } else {
                  await bot.sendMessage(sizeMsg.chat.id, "Trade cancelled. Use /openlimit to start again.");
                  return;
                }
              });
            } else {
              await continueLimitTradeFlow(bot, sizeMsg.chat.id, tradeState, maxLeverage);
            }
          } catch (error) {
            console.error("Trade processing error:", error);
            await bot.sendMessage(sizeMsg.chat.id, "Error processing trade. Please try again.");
          }
        });
      });
    });
  } catch (error) {
    console.error("Handle limit trade error:", error);
    await bot.sendMessage(msg.chat.id, "Failed to open limit trade. Please try again.");
  }
}

async function continueLimitTradeFlow(bot, chatId, tradeState, maxLeverage) {
  await bot.sendMessage(chatId, 
    `Size: ${tradeState.size} USDC. Now enter leverage:\nMax leverage for this pair is ${maxLeverage}x`
  );

  bot.once("message", async (leverageMsg) => {
    const leverage = leverageMsg.text;
    
    if (isNaN(leverage) || parseFloat(leverage) <= 0 || parseFloat(leverage) > maxLeverage) {
      await bot.sendMessage(leverageMsg.chat.id, `Invalid leverage. Please enter a valid number between 1 and ${maxLeverage}x`);
      return;
    }

    tradeState.leverage = parseFloat(leverage);

    let text;
    if(tradeState.buy) {
      text = `Below ${tradeState.price>1?parseFloat(tradeState.price).toFixed(2):parseFloat(tradeState.price).toFixed(4)} $.`;
    } else {
      text = `Above ${tradeState.price>1?parseFloat(tradeState.price).toFixed(2):parseFloat(tradeState.price).toFixed(4)} $.`;
    }

    await bot.sendMessage(leverageMsg.chat.id, 
      `**Leverage: ${leverage}x**\n` +
      `Present Trading price of selected pair: ${parseFloat(tradeState.price).toFixed(2)}$\n` +
      `Enter the Limit Price ${text}`
    );

    bot.once("message", async (limitPriceMsg) => {
      const limitPrice = limitPriceMsg.text;

      if (isNaN(limitPrice) || parseFloat(limitPrice) <= 0) {
        await bot.sendMessage(limitPriceMsg.chat.id, "Invalid limit price. Please enter a valid number.");
        return;
      }

      tradeState.limitPrice = parseFloat(limitPrice);

      const slTpOptions = {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: "Yes", callback_data: "set_sl_tp:yes" }],
            [{ text: "No", callback_data: "set_sl_tp:no" }],
          ],
        }),
      };

      await bot.sendMessage(limitPriceMsg.chat.id, "Would you like to set Stop Loss and Take Profit?", slTpOptions);

      bot.once("callback_query", async (slTpCallback) => {
        const [action, value] = slTpCallback.data.split(":");
        
        if (value === "yes") {
          await bot.sendMessage(slTpCallback.message.chat.id, `Enter Stop Loss price (or 'skip' to skip):\n`+
          `Set Stoploss ${tradeState.buy?`Below`:`Above`}, Your Limit Price ${tradeState.limitPrice>1?`${parseFloat(tradeState.limitPrice).toFixed(2)}`:`${parseFloat(tradeState.limitPrice).toFixed(2)}$`}\n`

          );
          
          bot.once("message", async (slMsg) => {
            if (slMsg.text.toLowerCase() === 'skip') {
              tradeState.stopLoss = 0;
            } else {
              const stopLoss = parseFloat(slMsg.text);
              if (isNaN(stopLoss) || stopLoss <= 0) {
                await bot.sendMessage(slMsg.chat.id, "Invalid Stop Loss. Please try again /openlimit");
                return;
              }
              tradeState.stopLoss = stopLoss;
            }

            await bot.sendMessage(slMsg.chat.id, `Enter Take Profit price (or 'skip' to skip):\n`+
              `Set Take Profit ${tradeState.buy?`Above`:`Below`} Limit Price ${tradeState.limitPrice>1?`${parseFloat(tradeState.limitPrice).toFixed(2)}`:`${parseFloat(tradeState.limitPrice).toFixed(2)}$`}\n`

            );
            
            bot.once("message", async (tpMsg) => {
              if (tpMsg.text.toLowerCase() === 'skip') {
                tradeState.takeProfit = 0;
              } else {
                const takeProfit = parseFloat(tpMsg.text);
                if (isNaN(takeProfit) || takeProfit <= 0) {
                  await bot.sendMessage(tpMsg.chat.id, "Invalid Take Profit. Please try again /openlimit");
                  return;
                }
                tradeState.takeProfit = takeProfit;
              }

              await bot.sendMessage(tpMsg.chat.id, "Please check your wallet for trade confirmation...");
              await proceedWithLimitTrade(
                bot,
                tpMsg.chat.id,
                tradeState.selectedPair,
                tradeState.size,
                tradeState.leverage,
                tradeState.limitPrice,
                tradeState.price,
                tradeState.buy,
                tradeState.stopLoss || 0,
                tradeState.takeProfit || 0
              );
            });
          });
        } else {
          tradeState.stopLoss = 0;
          tradeState.takeProfit = 0;
          await bot.sendMessage(slTpCallback.message.chat.id, "Please check your wallet for trade confirmation...");
          await proceedWithLimitTrade(
            bot,
            slTpCallback.message.chat.id,
            tradeState.selectedPair,
            tradeState.size,
            tradeState.leverage,
            tradeState.limitPrice,
            tradeState.price,
            tradeState.buy,
            0,
            0
          );
        }
      });
    });
  });
}
// New function to handle limit trade execution with blockchain confirmation
async function proceedWithLimitTrade(bot, chatId, selectedPair, size, leverage, limitPrice, currentPrice, buy, stopLoss, takeProfit) {
  try {
    const userSession = await getUserSession(chatId);

    // Calculate adjusted stop-loss
    const adjustedStopLoss = (calculateStopLoss(limitPrice, stopLoss, leverage, buy)).toFixed(3);

    // Prepare trade parameters
    const tradeParams = {
      trader: userSession.address,
      pairIndex: PAIRS_OBJECT[selectedPair],
      index: 0,
      initialPosToken: 0,
      positionSizeUSDC: ethers.parseUnits(size.toString(), 6),
      openPrice: ethers.parseUnits(limitPrice.toString(), 10),
      buy: buy,
      leverage: ethers.parseUnits(leverage.toString(), 10),
      tp: takeProfit ? ethers.parseUnits(takeProfit.toString(), 10) : 0,
      sl: stopLoss ? ethers.parseUnits(adjustedStopLoss.toString(), 10) : 0,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const type = 2; // Limit order
    const slippageP = ethers.parseUnits("1", 10); // 0.3%
    const executionFee = 0;

    // Encode function call
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
  chatId,  // Make sure chatId is defined and correct
  `Limit trade transaction submitted! Hash: ${result}\n`+
  `Waiting for blockchain confirmation...`
);

// Wait for blockchain confirmations
const startTime = Date.now();
const maxWaitTime = 2 * 60 * 1000;

const checkConfirmations = async () => {
  try {
    const receipt = await Provider.getTransactionReceipt(result);
    
    if (receipt) {
      const currentBlock = await Provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber;

      console.log(currentBlock, confirmations)

      if (confirmations >= 3) {
        await bot.editMessageText(
          `Limit Order Confirmed! ✅\n` +
          `Transaction Hash: ${result}\n` +
          `Confirmations: ${confirmations}\n` +
          `Check your trades using /opentrades.`,
          {
            chat_id: initialMessage.chat.id,
            message_id: initialMessage.message_id
          }
        );
        return; // Exit the function after successful confirmation
      }
    }

    if (Date.now() - startTime < maxWaitTime) { 
      setTimeout(checkConfirmations, 5000);
    } else {
      await bot.editMessageText(
        `Limit Order transaction timed out. Please try again.\n` +
        `Transaction Hash: ${result}`,
        {
          chat_id: initialMessage.chat.id,
          message_id: initialMessage.message_id
        }
      );
    }
  } catch (error) {
    console.error("Confirmation check error:", error);
  }
};

await checkConfirmations();

  } catch (error) {
    console.error("Open limit trade error:", error.message);
    await bot.sendMessage(chatId, `Failed to open limit trade. Error: ${error.message}`);
  }
}


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
              const neededApproval = ethers.formatUnits(requiredAmount, 6);
              
              const approveOptions = {
                reply_markup: JSON.stringify({
                  inline_keyboard: [
                    [{ text: "📝 Approve USDC", callback_data: `approve:${neededApproval}` }],
                    [{ text: "❌ Cancel", callback_data: "approve:cancel" }],
                  ],
                }),
              };

              await bot.sendMessage(sizeMsg.chat.id, 
                `⚠️ Insufficient Approval!\n\n` +
                `Current Allowance: ${ethers.formatUnits(check_allowance, 6)} USDC\n` +
                `Required Amount: ${size} USDC\n` +
                `Additional Needed: ${neededApproval} USDC`, 
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

                  bot.once("message", async (leverageMsg) => {
                    const leverage = leverageMsg.text;
                    
                    if (isNaN(leverage) || parseFloat(leverage) <= 0 || parseFloat(leverage) > maxLeverage) {
                      await bot.sendMessage(leverageMsg.chat.id, `Invalid leverage. Please enter a valid number between 1 and ${maxLeverage}x`);
                      return;
                    }

                    tradeState.leverage = parseFloat(leverage);

                    const slTpOptions = {
                      reply_markup: JSON.stringify({
                        inline_keyboard: [
                          [{ text: "Yes", callback_data: "set_sl_tp:yes" }],
                          [{ text: "No", callback_data: "set_sl_tp:no" }],
                        ],
                      }),
                    };

                    await bot.sendMessage(leverageMsg.chat.id, "Would you like to set Stop Loss and Take Profit?", slTpOptions);

                    bot.once("callback_query", async (slTpCallback) => {
                      const [action, value] = slTpCallback.data.split(":");
                      
                      if (value === "yes") {
                        await bot.sendMessage(slTpCallback.message.chat.id, `Enter Stop Loss price (or 'skip' to skip):\n`+
                          `Set Stoploss ${tradeState.buy?`Below`:`Above`} Market Price ${tradeState.price>1?`${parseFloat(tradeState.price).toFixed(2)}`:`${parseFloat(tradeState.price).toFixed(2)}$`}\n`
                          
                        );
                        
                        bot.once("message", async (slMsg) => {
                          if (slMsg.text.toLowerCase() === 'skip') {
                            tradeState.stopLoss = 0;
                          } else {
                            const stopLoss = parseFloat(slMsg.text);
                            if (isNaN(stopLoss) || stopLoss <= 0) {
                              await bot.sendMessage(slMsg.chat.id, "Invalid Stop Loss. Please try again /openmarket");
                              return;
                            }
                            tradeState.stopLoss = stopLoss;
                          }

                          await bot.sendMessage(slMsg.chat.id, `Enter Take Profit price (or 'skip' to skip):\n`+
                            `Set Take Profit ${tradeState.buy?`Above`:`Below`} Market Price ${tradeState.price>1?`${parseFloat(tradeState.price).toFixed(2)}`:`${parseFloat(tradeState.price).toFixed(2)}$`}\n`

                          );
                          
                          bot.once("message", async (tpMsg) => {
                            if (tpMsg.text.toLowerCase() === 'skip') {
                              tradeState.takeProfit = 0;
                            } else {
                              const takeProfit = parseFloat(tpMsg.text);
                              if (isNaN(takeProfit) || takeProfit <= 0) {
                                await bot.sendMessage(tpMsg.chat.id, "Invalid Take Profit. Please try again /openmarket");
                                return;
                              }
                              tradeState.takeProfit = takeProfit;
                            }

                            await bot.sendMessage(tpMsg.chat.id, "Please check your wallet for trade confirmation...");
                            await proceedWithTrade(
                              bot,
                              tpMsg.chat.id,
                              tradeState.selectedPair,
                              tradeState.size,
                              tradeState.leverage,
                              tradeState.price,
                              tradeState.buy,
                              tradeState.stopLoss || 0,
                              tradeState.takeProfit || 0
                            );
                          });
                        });
                      } else {
                        tradeState.stopLoss = 0;
                        tradeState.takeProfit = 0;
                        await bot.sendMessage(slTpCallback.message.chat.id, "Please check your wallet for trade confirmation...");
                        await proceedWithTrade(
                          bot,
                          slTpCallback.message.chat.id,
                          tradeState.selectedPair,
                          tradeState.size,
                          tradeState.leverage,
                          tradeState.price,
                          tradeState.buy,
                          0,
                          0
                        );
                      }
                    });
                  });
                } else {
                  await bot.sendMessage(sizeMsg.chat.id, "Trade cancelled. Use /openmarket to start again.");
                  return;
                }
              });
            } else {
              await bot.sendMessage(sizeMsg.chat.id, 
                `Size: ${size} USDC. Now enter leverage:\nMax leverage for this pair is ${maxLeverage}x`
              );

              bot.once("message", async (leverageMsg) => {
                const leverage = leverageMsg.text;
                
                if (isNaN(leverage) || parseFloat(leverage) <= 0 || parseFloat(leverage) > maxLeverage) {
                  await bot.sendMessage(leverageMsg.chat.id, `Invalid leverage. Please enter a valid number between 1 and ${maxLeverage}x`);
                  return;
                }

                tradeState.leverage = parseFloat(leverage);

                const slTpOptions = {
                  reply_markup: JSON.stringify({
                    inline_keyboard: [
                      [{ text: "Yes", callback_data: "set_sl_tp:yes" }],
                      [{ text: "No", callback_data: "set_sl_tp:no" }],
                    ],
                  }),
                };

                await bot.sendMessage(leverageMsg.chat.id, "Would you like to set Stop Loss and Take Profit?", slTpOptions);

                bot.once("callback_query", async (slTpCallback) => {
                  const [action, value] = slTpCallback.data.split(":");
                  
                  if (value === "yes") {
                    await bot.sendMessage(slTpCallback.message.chat.id, "Enter Stop Loss price (or 'skip' to skip):\n"+
                      `Set Stoploss ${tradeState.buy?`Below`:`Above`} Current Price ${tradeState.price>1?`${parseFloat(tradeState.price).toFixed(2)}$`:`${parseFloat(tradeState.price).toFixed(2)}$`}\n`

                    );
                    
                    bot.once("message", async (slMsg) => {
                      if (slMsg.text.toLowerCase() === 'skip') {
                        tradeState.stopLoss = 0;
                      } else {
                        const stopLoss = parseFloat(slMsg.text);
                        if (isNaN(stopLoss) || stopLoss <= 0) {
                          await bot.sendMessage(slMsg.chat.id, "Invalid Stop Loss. Please try again /openmarket");
                          return;
                        }
                        tradeState.stopLoss = stopLoss;
                      }

                      await bot.sendMessage(slMsg.chat.id, `Enter Take Profit price (or 'skip' to skip):\n`+
                        `Set Take profit ${tradeState.buy?`Above`:`Below`} Current Price ${tradeState.price>1?`${parseFloat(tradeState.price).toFixed(2)}$`:`${parseFloat(tradeState.price).toFixed(2)}$`}\n`

                      );
                      
                      bot.once("message", async (tpMsg) => {
                        if (tpMsg.text.toLowerCase() === 'skip') {
                          tradeState.takeProfit = 0;
                        } else {
                          const takeProfit = parseFloat(tpMsg.text);
                          if (isNaN(takeProfit) || takeProfit <= 0) {
                            await bot.sendMessage(tpMsg.chat.id, "Invalid Take Profit. Please try again /openmarket");
                            return;
                          }
                          tradeState.takeProfit = takeProfit;
                        }

                        await bot.sendMessage(tpMsg.chat.id, "Please check your wallet for trade confirmation...");
                        await proceedWithTrade(
                          bot,
                          tpMsg.chat.id,
                          tradeState.selectedPair,
                          tradeState.size,
                          tradeState.leverage,
                          tradeState.price,
                          tradeState.buy,
                          tradeState.stopLoss || 0,
                          tradeState.takeProfit || 0
                        );
                      });
                    });
                  } else {
                    tradeState.stopLoss = 0;
                    tradeState.takeProfit = 0;
                    await bot.sendMessage(slTpCallback.message.chat.id, "Please check your wallet for trade confirmation...");
                    await proceedWithTrade(
                      bot,
                      slTpCallback.message.chat.id,
                      tradeState.selectedPair,
                      tradeState.size,
                      tradeState.leverage,
                      tradeState.price,
                      tradeState.buy,
                      0,
                      0
                    );
                  }
                });
              });
            }
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

//New function to handle trade execution with blockchain confirmation



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
      positionSizeUSDC: ethers.parseUnits(size.toString(), 6),
      openPrice: ethers.parseUnits(Price.toString(), 10),
      buy: buy,
      leverage: ethers.parseUnits(leverage.toString(), 10),
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
    `Market trade transaction submitted! Hash: ${result}\n`+
    `Waiting for blockchain confirmation...`
  );

  // Wait for blockchain confirmations
  const startTime = Date.now();
  const maxWaitTime = 2 * 60 * 1000; // 2 minutes timeout

  const checkConfirmations = async () => {
    try {
      const receipt = await Provider.getTransactionReceipt(result);
      
      if (receipt) {
        const currentBlock = await Provider.getBlockNumber();
        const confirmations = currentBlock - receipt.blockNumber;

        console.log("Current Block:", currentBlock, "Confirmations:", confirmations);

        if (confirmations >= 3) {
          await bot.editMessageText(
            `Market Order Confirmed! ✅\n` +
            `Transaction Hash: ${result}\n` +
            `Confirmations: ${confirmations}\n` +
            `Check your trades using /opentrades.`,
            {
              chat_id: initialMessage.chat.id,
              message_id: initialMessage.message_id
            }
          );
          return; // Exit after successful confirmation
        }
      }

      if (Date.now() - startTime < maxWaitTime) { 
        setTimeout(checkConfirmations, 5000); // Check every 5 seconds
      } else {
        await bot.editMessageText(
          `Market Order transaction timed out. Please check /opentrades to verify status.\n` +
          `Transaction Hash: ${result}`,
          {
            chat_id: initialMessage.chat.id,
            message_id: initialMessage.message_id
          }
        );
      }
    } catch (error) {
      console.error("Market trade confirmation check error:", error);
      // Optionally notify user of error
      await bot.editMessageText(
        `Error checking Market Order status. Please check /opentrades to verify status.\n` +
        `Transaction Hash: ${result}`,
        {
          chat_id: initialMessage.chat.id,
          message_id: initialMessage.message_id
        }
      );
    }
  };

  await checkConfirmations();
    

  } catch (error) {
    console.error("Open trade error:", error.message);
    await bot.sendMessage(chatId, `Failed to open trade. Error: ${error}`);
  }
}




async function price(params) {
    const connection = new PriceServiceConnection("https://hermes.pyth.network");

    const currentPrices = await connection.getLatestPriceFeeds(params?.id);

    const price = String((currentPrices[0].price.price)/10**8);

    return price;
}




async function handleGetTrades(bot, msg, contractInstance) {
  const chatId = msg.chat.id; 
  console.log("Chat ID",chatId)
  // Fetch user session from your database
  const userSession = await getUserSession(chatId);
  if (!userSession || !userSession.address) {
    await bot.sendMessage(chatId, "Please connect your wallet first using /connect , Make sure wallet supports Base chain");
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

        const pairName = pairs_with_index_number[parseInt((trade.pairIndex).toString())] || "Unknown Pair";

        
        const openPrice = ethers.formatUnits(trade.openPrice, 10);
        const currentPrices = await price({ id: [feedIds[pairName.toUpperCase()].id] })
        
        const tradeMessage = `
        🚀 TRADE INSIGHTS 📊

        ${trade.buy ? "🟢 LONG" : "🔴 SHORT"} | ${pairName.toUpperCase()}

        ✨ Position State 
        ────────────────────
        ${trade.buy?(openPrice<currentPrices?"Profit 🤑":"Loss 😞"):(openPrice>currentPrices?"Profit 🤑":"Loss 😞")}
        
        (Profit/Loss API 
        Integration Soon)

        💰 Position Details
        ────────────────────
        📍 Position Size: ${parseFloat(ethers.formatUnits(trade.initialPosToken, 6)).toFixed(2)} USDC
        ⚡ Leverage: ${ethers.formatUnits(trade.leverage, 10)}x
        💰 Volume: ${parseFloat(ethers.formatUnits(trade.initialPosToken, 6)*ethers.formatUnits(trade.leverage, 10))}

        🎯 Trade Markers
        ────────────────────
        🔹 Open Price: ${openPrice>1?parseFloat(openPrice).toFixed(2):parseFloat(openPrice).toFixed(4)}$
        💹 Current Price: ${currentPrices>1?parseFloat(currentPrices).toFixed(2) || "NaN":parseFloat(currentPrices).toFixed(4) || "NaN"}$
         
        🚦 Take Profit: ${trade?.tp>1?parseFloat(ethers.formatUnits(trade.tp, 10)).toFixed(2):parseFloat(ethers.formatUnits(trade.tp, 10)).toFixed(4)}$
        ⚠️ Stop Loss: ${trade?.sl>1?parseFloat(ethers.formatUnits(trade.sl, 10)).toFixed(2):parseFloat(ethers.formatUnits(trade.sl, 10)).toFixed(4)}$
        💥 Liquidation: ${trade?.liquidationPrice>1?parseFloat(ethers.formatUnits(trade.liquidationPrice, 10)).toFixed(2):parseFloat(ethers.formatUnits(trade.liquidationPrice, 10)).toFixed(4)}$


        ${trade.buy ? "🚀 Riding the Bullish Wave" : "🐻 Navigating Bearish Currents"}

        💡 Smart Trading Tip:
        Risk wisely, trade confidently! 
        Your strategic move starts here. 🌟
        `;


        await bot.sendMessage(chatId, tradeMessage, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Close ❌",
                  callback_data: `close_trade:${trade.pairIndex}:${trade.index}:${ethers.formatUnits(trade.initialPosToken, 6)}`,
                },
                {
                  text: "Close Partial 📉",
                  callback_data: `close_partial:${trade.pairIndex}:${trade.index}:${ethers.formatUnits(trade.initialPosToken, 6)}`,
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
        const pairName = pairs_with_index_number[parseInt((order.pairIndex).toString())] || "Unknown Pair";

        const orderMessage = `
          **Pending Order:**
          - Pair: ${pairName}
          - Position Size: ${ethers.formatUnits(order.positionSize, 6)}
          - Leverage: ${ethers.formatUnits(order.leverage, 10)}x
          - Price: ${ethers.formatUnits(order.price, 10)}
          - Take Profit: ${ethers.formatUnits(order.tp, 10)}
          - Stop Loss: ${ethers.formatUnits(order.sl, 10)}
                  `;

                  await bot.sendMessage(chatId, orderMessage, {
                    parse_mode: "Markdown",
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "Close ❌",
                            callback_data: `close_limit_trade:${order.pairIndex}:${order.index}}`,
                          },
                        ],
                      ],
                    },
                  });
      }
    }
  } catch (error) {
    console.error("Error fetching trades:", error);
    await bot.sendMessage(chatId, "Failed to fetch trades. Please try again later.");
  }
}

// Handle trade close callback
async function handleTradeCloseCallback(bot, query, contractInstance,size) {
  const chatId = query.message.chat.id;

  const userSession = await getUserSession(chatId);
  if (!userSession || !userSession.address) {
    await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
    return;
  }

 

  const callbackData = query.data.split(":");
  console.log(query.data)
  const pairIndex = parseInt(callbackData[1], 10);
  const tradeIndex = parseInt(callbackData[2], 10);
  const tradeSize = !size?parseFloat(callbackData[3]):size;
  

  try {

    // Execution fee (you may replace this with dynamic calculation if needed)
    const tradeParams = {
      pairIndex: pairIndex, // Map `selectedPair` to pairIndex based on backend logic
      index: tradeIndex,
      amount:ethers.parseUnits(tradeSize.toString(),6),
      executionFee:0
    };

    console.log(tradeParams)


    // Encode the function call
    const iface = new ethers.Interface(TRADING_ABI);
    const data = iface.encodeFunctionData('closeTradeMarket', [
        tradeParams.pairIndex,
        tradeParams.index,
        tradeParams.amount,
        tradeParams.executionFee,
    ]);

    await bot.sendMessage(query.message.chat.id, 'Check your wallet for approval...');

    const valueInWei = ethers.parseUnits("0.000006", "ether").toString(16); // Convert ETH to wei and then to hex
    const valueHex = `0x${valueInWei}`; // Add the "0x" prefix for a valid hexadecimal representation

    const { result } = await makeWalletConnectRequest(`/request/${userSession.topic}`, 'POST', {
      chainId: `eip155:${BASE_CHAIN_ID}`,
      request: {
        method: 'eth_sendTransaction',
        params: [
          {
            from: userSession.address,
            to: CONTRACT_ADDRESS_TRADING,
            data: data,
            value: valueHex,
          },
        ],
      },
    });

    const initialMessage = await bot.sendMessage(
      chatId,
      `Market Close transaction submitted! Hash: ${result}\n`+
      `Waiting for blockchain confirmation...`
    );

    // Wait for blockchain confirmations
    const startTime = Date.now();
    const maxWaitTime = 2 * 60 * 1000; // 2 minutes timeout

    const checkConfirmations = async () => {
      try {
        const receipt = await Provider.getTransactionReceipt(result);
        
        if (receipt) {
          const currentBlock = await Provider.getBlockNumber();
          const confirmations = currentBlock - receipt.blockNumber;

          console.log("Current Block:", currentBlock, "Confirmations:", confirmations);

          if (confirmations >= 3) {
            await bot.editMessageText(
              `Position Closed Successfully! ✅\n` +
              `Transaction Hash: ${result}\n` +
              `Confirmations: ${confirmations}\n` +
              `Check your trades using /closedtrades.`,
              {
                chat_id: initialMessage.chat.id,
                message_id: initialMessage.message_id
              }
            );
            return; // Exit after successful confirmation
          }
        }

        if (Date.now() - startTime < maxWaitTime) { 
          setTimeout(checkConfirmations, 5000); // Check every 5 seconds
        } else {
          await bot.editMessageText(
            `Market Close transaction timed out. Please check /opentrades to verify status.\n` +
            `Transaction Hash: ${result}`,
            {
              chat_id: initialMessage.chat.id,
              message_id: initialMessage.message_id
            }
          );
        }
      } catch (error) {
        console.error("Market close confirmation check error:", error);
        await bot.editMessageText(
          `Error checking Market Close status. Please check /opentrades to verify status.\n` +
          `Transaction Hash: ${result}`,
          {
            chat_id: initialMessage.chat.id,
            message_id: initialMessage.message_id
          }
        );
      }
    };

    await checkConfirmations();
  } catch (error) {
    // console.log(error.message)
    await bot.answerCallbackQuery(query.id, { text: "Failed to close trade. Try again later." });
  }
}

async function handleTradeCloseCallback_limit(bot, query, contractInstance) {
  const chatId = query.message.chat.id;

  try {
    // Check user session
    const userSession = await getUserSession(chatId);
    if (!userSession || !userSession.address) {
      await bot.answerCallbackQuery(query.id);  // Close the callback query
      await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
      return;
    }
  
    const callbackData = query.data.split(":");
    console.log("Callback data:", query.data);
    const pairIndex = parseInt(callbackData[1], 10);
    const tradeIndex = parseInt(callbackData[2], 10);

    // Encode the function call
    const iface = new ethers.Interface(TRADING_ABI);
    const data = iface.encodeFunctionData('cancelOpenLimitOrder', [
        pairIndex,
        tradeIndex,
    ]);

    // Send initial wallet check message
    const walletMsg = await bot.sendMessage(chatId, 'Check your wallet for approval...');

    // Make wallet connect request
    const { result } = await makeWalletConnectRequest(`/request/${userSession.topic}`, 'POST', {
      chainId: `eip155:${BASE_CHAIN_ID}`,
      request: {
        method: 'eth_sendTransaction',
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

    // Delete the wallet check message
    await bot.deleteMessage(chatId, walletMsg.message_id);

    // Send the initial transaction message
    const initialMessage = await bot.sendMessage(
      chatId,
      `Cancel Limit Order submitted! Hash: ${result}\n`+
      `Pair Index: ${pairIndex}, Trade Index: ${tradeIndex}\n`+
      `Waiting for blockchain confirmation...`
    );

    // Answer the callback query to remove loading state
    await bot.answerCallbackQuery(query.id);

    // Wait for blockchain confirmations
    const startTime = Date.now();
    const maxWaitTime = 2 * 60 * 1000; // 2 minutes timeout

    const checkConfirmations = async () => {
      try {
        const receipt = await Provider.getTransactionReceipt(result);
        
        if (receipt) {
          const currentBlock = await Provider.getBlockNumber();
          const confirmations = currentBlock - receipt.blockNumber;

          if (confirmations >= 3) {
            await bot.editMessageText(
              `Cancel Limit Order Successful! ✅\n` +
              `Pair Index: ${pairIndex}, Trade Index: ${tradeIndex}\n` +
              `Transaction Hash: ${result}\n` +
              `Confirmations: ${confirmations}\n` +
              `Check your trades using /opentrades.`,
              {
                chat_id: initialMessage.chat.id,
                message_id: initialMessage.message_id,
                parse_mode: 'HTML'
              }
            );
            return; // Exit after successful confirmation
          }
        }

        if (Date.now() - startTime < maxWaitTime) { 
          setTimeout(checkConfirmations, 5000); // Check every 5 seconds
        } else {
          await bot.editMessageText(
            `Cancel Limit Order transaction timed out. Please check /opentrades to verify status.\n` +
            `Pair Index: ${pairIndex}, Trade Index: ${tradeIndex}\n` +
            `Transaction Hash: ${result}`,
            {
              chat_id: initialMessage.chat.id,
              message_id: initialMessage.message_id,
              parse_mode: 'HTML'
            }
          );
        }
      } catch (error) {
        console.error("Cancel limit order confirmation check error:", error);
        // Only try to edit message if we still have the message ID
        if (initialMessage?.message_id) {
          await bot.editMessageText(
            `Error checking Cancel Limit Order status. Please check /opentrades to verify status.\n` +
            `Pair Index: ${pairIndex}, Trade Index: ${tradeIndex}\n` +
            `Transaction Hash: ${result}`,
            {
              chat_id: initialMessage.chat.id,
              message_id: initialMessage.message_id,
              parse_mode: 'HTML'
            }
          );
        }
      }
    };

    await checkConfirmations();
  } catch (error) {
    console.error("Handle limit trade cancellation error:", error);
    // Make sure to answer the callback query in case of error
    try {
      await bot.answerCallbackQuery(query.id, { 
        text: "Failed to cancel limit order. Please try again later.",
        show_alert: true 
      });
    } catch (cbError) {
      console.error("Error answering callback query:", cbError);
    }
    // Send a separate error message
    await bot.sendMessage(chatId, "❌ Failed to cancel limit order. Please try again later.");
  }
}

//Store Trades to DataBase

async function storeTrade(chatId, orderId, txHash) {
    return new Promise((resolve, reject) => {
      const timestamp = Math.floor(Date.now() / 1000);
      db.run(
        'INSERT INTO trades (chat_id, order_id, timestamp, tx_hash) VALUES (?, ?, ?, ?)',
        [chatId, orderId, timestamp, txHash],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async function handleViewTrades(bot, msg) {
    try {
      const trades = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM trades WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 5', 
          [msg.chat.id], 
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
      });
  
      if (trades.length === 0) {
        await bot.sendMessage(msg.chat.id, 'No trades found.');
        return;
      }
  
      const tradesMessage = trades.map(trade => 
        `Order ID: ${trade.order_id}\n` +
        `Transaction: ${trade.tx_hash}\n` +
        `Time: ${new Date(trade.timestamp * 1000).toLocaleString()}\n`
      ).join('\n');
  
      await bot.sendMessage(msg.chat.id, `Your recent trades:\n\n${tradesMessage}`);
  
    } catch (error) {
      console.error('View trades error:', error);
      await bot.sendMessage(msg.chat.id, 'Failed to fetch trades. Please try again.');
    }
  }
  


  async function getUserSession(chatId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT topic, address, session_data FROM user_sessions WHERE chat_id = ?', [chatId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? {
            ...row,
            session_data: row.session_data ? JSON.parse(row.session_data) : null
          } : null);
        }
      });
    });
  }
  
  async function saveUserSession(chatId, topic, address, sessionData) {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT OR REPLACE INTO user_sessions (chat_id, topic, address, session_data) VALUES (?, ?, ?, ?)',
        [chatId, topic, address, sessionData],
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }
  
 
// Other functions (handleViewTrades, getUserSession, saveUserSession, etc.) remain the same...

// Start the bot with enhanced error handling and recovery
(async () => {
  async function startBot() {
    try {
      await initBot();
    } catch (error) {
      console.error('Bot initialization failed:', error);
      // Implement exponential backoff retry
      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const backoffDelay = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.warn(`Attempting to restart bot (Attempt ${attempt}/${maxRetries}) in ${backoffDelay/1000} seconds`);
          
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          await initBot();
          return; // Successfully started, exit retry loop
        } catch (retryError) {
          console.error(`Restart attempt ${attempt} failed:`, retryError);
          
          // If it's the last attempt, log final error but continue running
          if (attempt === maxRetries) {
            console.error('All bot restart attempts failed. Continuing with periodic retry.');
          }
        }
      }

      // Continue trying to restart periodically even after max retries
      setInterval(async () => {
        try {
          await initBot();
          console.log('Bot successfully restarted after persistent failure');
        } catch (persistentError) {
          console.error('Periodic restart attempt failed:', persistentError);
        }
      }, 5 * 60 * 1000); // Try every 5 minutes
    }
  }

  // Global error handlers to prevent process termination
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Attempt to restart
    startBot();
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Attempt to restart
    startBot();
  });

  // Initial bot start
  await startBot();
})();

