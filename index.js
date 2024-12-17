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
const {calculateStopLoss,profit_loss} = require('./trades/sl_tp');
const prices = require('./price/prices.json');
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WALLET_CONNECT_SERVICE_URL = process.env.WALLET_CONNECT_SERVICE_URL || 'http://localhost:3000';
const BASE_RPC = process.env.BASE_RPC
const CONTRACT_ADDRESS_TRADING = '0x5FF292d70bA9cD9e7CCb313782811b3D7120535f';
const BASE_CHAIN_ID = 8453;
const USDC_CONTRACT_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPENDER_APPROVE = "0x8a311d7048c35985aa31c131b9a13e03a5f7422d"

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
    bot.onText(/\/approve/, (msg) => handleApprove(bot, msg));
    bot.onText(/\/openmarket/, (msg) => handleMarketTrade(bot, msg));
    bot.onText(/\/verify/, (msg) => handleVerifyConnection(bot, msg));
    bot.onText(/\/opentrades/, (msg) => handleGetTrades(bot, msg, CONTRACT_INSTANCE_MULTICALL));
  
    await bot.setMyCommands([
        { command: '/start', description: 'Start the bot' },
        { command: '/connect', description: 'Connect your wallet' },
        { command: '/verify', description: 'Verify wallet connection'},
        { command: '/openlimit', description: 'Open a new Limit order for selected pair' },
        { command: '/opentrades', description: 'View your recent trades'},
        { command: '/approve', description: 'Approve spending limit of Contract' },
        { command: '/openmarket', description: 'Open a Market trade for the selected pair' },
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
  
      /*if (uri) {
        const qrCodeImage = await QRCode.toBuffer(uri);
        const statusMessage = await bot.sendMessage(msg.chat.id, 'Connecting wallet...');
  
        // Wallet-specific deep links
        const walletLinks = [
          {
            name: 'MetaMask',
            link: `https://t.me/iv?url=${encodeURIComponent(`metamask://wc?uri=${uri}`)}&rhash=...`, // You'll need to get the rhash from Telegram
            icon: '🦊'
          },
          {
            name: 'Trust Wallet',
            link: `https://t.me/iv?url=${encodeURIComponent(`trust://wc?uri=${uri}`)}&rhash=...`,
            icon: '🛡️'
          }
        ];
        // Create clickable wallet connection links
        const walletLinksText = walletLinks.map(wallet => 
          `${wallet.icon} [Connect with ${wallet.name}](${wallet.link})`
          
        ).join('\n');
        
        function escapeMarkdown(text) {
          return text.replace(/[_*[\]]/g, '\\$&');
        }
        
        const escapedUri = escapeMarkdown(uri);
        
        await bot.sendPhoto(msg.chat.id, qrCodeImage, {
          caption: 
            `Scan QR Code or Quick Connect:\n\n` +
            `${walletLinksText}\n\n` +
            `Scan the QR code or tap a wallet link to connect.\n` +
            `OR Directly paste this URI in your wallet: \`${escapedUri}\``, // Highlight the URI
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: walletLinks.map(wallet => [
              {
                text: `${wallet.icon} Connect ${wallet.name}`,
                url: wallet.link
              }
            ])
          }
        });

        */


        if (uri) {
          // Generate QR Code
          const qrCodeImage = await QRCode.toBuffer(uri);

          const statusMessage = await bot.sendMessage(msg.chat.id, 'Connecting wallet...');
        
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
              name: 'SafePal',
              redirectScheme: 'safe',
              icon: '🔐',
            },
            {
              name: 'OKX',
              redirectScheme: 'okx',
              icon: '⭕️',
            },
            {
              name: 'Zerion',
              redirectScheme: 'zerion',
              icon: '🌐',
            },
            {
              name: 'TokenPocket',
              redirectScheme: 'tp',
              icon: '💼',
            },
            {
              name: 'Rainbow',
              redirectScheme: 'rainbow',
              icon: '🌈',
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
                
        
        // Poll for session status
        const maxAttempts = 60; // 1 minute timeout
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

async function handleApprove(bot,msg) {
    const [, amount] = msg.text.split(' ');

    if (!amount) {
        await bot.sendMessage(msg.chat.id, 'Please provide amount to spend: /approve <amount>');
        return;
      }

    try {
        const userSession = await getUserSession(msg.chat.id);
        if (!userSession || !userSession.topic || !userSession.address) {
          await bot.sendMessage(msg.chat.id, 'Please connect your wallet first using /connect');
          return;
        }
        const check_allowance = await CONTRACT_INSTANCE_USDC.allowance(userSession.address,SPENDER_APPROVE);
        console.log(check_allowance,"hnn")

        try {
            await makeWalletConnectRequest(`/session/${userSession.topic}`, 'GET');
            console.log('initialized')
          } catch (error) {
            await bot.sendMessage(msg.chat.id, 'Your wallet session has expired. Please reconnect using /connect');
            return;
          }
     
          const approveParams = {
              spender: SPENDER_APPROVE,
              allowance: ethers.parseUnits(amount?.toString(),6)
            };
          
            const iface = new ethers.Interface(USDC_ABI);
            console.log(iface)
            const data = iface.encodeFunctionData("approve", [
             
                approveParams.spender,
                approveParams.allowance,
                
            ]);

            console.log(data)
      
        await bot.sendMessage(msg.chat.id, 'Approve spending to the contract. Please check your wallet for approval...');
  
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
  
        await bot.sendMessage(msg.chat.id, `Approve transaction submitted! Hash: ${result} \n Waiting for confirmation...`);
   
  
    } catch (error) {
        
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

    // Step 1: Show trading pairs menu
    showPairsMenu(bot, msg.chat.id, "limit");

    // Step 2: Handle pair selection via callback
    bot.once("callback_query", async (callbackQuery) => {
      const { data, message } = callbackQuery;
      const [action, type, selectedPair] = data.split(":");

      if (action !== "select_pair" || type !== "limit") {
        await bot.sendMessage(message.chat.id, "Invalid selection. Please try again.");
        return;
      }

      const Price = await price({ id: [feedIds[selectedPair].id] });
      const maxLevearage = feedIds[selectedPair].leverage || "NaN"

     
      // Ask for Long or Short
      const options = {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: "Long 🟢", callback_data: `trade_direction:long:${selectedPair}` }],
            [{ text: "Short 🔴", callback_data: `trade_direction:short:${selectedPair}` }],
          ],
        }),
      };

      await bot.sendMessage(message.chat.id, "Do you want to go Long🟢 or Short🔴?", options);

      // Step 3: Handle Long/Short selection
      bot.once("callback_query", async (directionCallback) => {
        const directionData = directionCallback.data.split(":");
        const direction = directionData[1]; // "long" or "short"
        const buy = direction === "long"; // Long => true, Short => false

        await bot.sendMessage(message.chat.id, `You selected ${buy ? "Long 🟢" : "Short 🔴"}. Enter the size in USDC:`);

        // Step 4: Wait for size input
        bot.once("message", async (sizeMsg) => {
          const size = sizeMsg.text;

          if (isNaN(size) || parseFloat(size) <= 0) {
            await bot.sendMessage(sizeMsg.chat.id, "Invalid size. Please enter a valid number.");
            return;
          }

          await bot.sendMessage(sizeMsg.chat.id, `Size: ${size} USDC. Now enter leverage: \nMax leverage for this pair is ${maxLevearage}x`);

          // Step 5: Wait for leverage input
          bot.once("message", async (leverageMsg) => {
            const leverage = leverageMsg.text;

            if (isNaN(leverage) || parseFloat(leverage) <= 0) {
              await bot.sendMessage(leverageMsg.chat.id, "Invalid leverage. Please enter a valid number.");
              return;
            }

            let text;

            if(buy){
              text = `Below ${Price} $.`
            }else {
              text = `Above ${Price} $.`
            }

            await bot.sendMessage(leverageMsg.chat.id, `Leverage: ${leverage}x \n Present Trading price of selected pair: ${parseFloat(Price).toFixed(2)}$\n Enter the Limit Price ${text}:`);

           

            // Step 6: Wait for limit price input
            bot.once("message", async (priceMsg) => {
              const limitPrice = priceMsg.text;

              if (isNaN(limitPrice) || parseFloat(limitPrice) <= 0) {
                await bot.sendMessage(priceMsg.chat.id, "Invalid limit price. Please enter a valid number.");
                return;
              }

              await bot.sendMessage(priceMsg.chat.id, `Limit Price: ${parseFloat(limitPrice).toFixed(3)}$.\n Now enter Stop-Loss:`);

              // Step 7: Wait for Stop-Loss input
              bot.once("message", async (slMsg) => {
                const stopLoss = slMsg.text;

                if (isNaN(stopLoss) || parseFloat(stopLoss) <= 0) {
                  await bot.sendMessage(slMsg.chat.id, "Invalid Stop-Loss. Please enter a valid number.");
                  return;
                }

                await bot.sendMessage(slMsg.chat.id, `Stop-Loss: ${stopLoss}$. \n Preparing to open trade...`);

                try {
                  // Validate wallet
                  const check_allowance = await CONTRACT_INSTANCE_USDC.allowance(userSession.address, SPENDER_APPROVE);
                  const check_balance = await CONTRACT_INSTANCE_USDC.balanceOf(userSession.address);

                  if (check_balance < ethers.parseUnits(size.toString(), 6)) {
                    throw `Available Balance: ${ethers.formatUnits(check_balance, 6)}$ \n Required Balance: ${size}$`;
                  }

                  if (check_allowance < ethers.parseUnits(size.toString(), 6)) {
                    throw `Allowance of ${ethers.formatUnits(check_allowance, 6)}$ is less than ${size}$`;
                  }

                  // Calculate TP and adjusted SL
                  const adjustedStopLoss = (calculateStopLoss(limitPrice, stopLoss, leverage, buy));
                  const trimmed_stopLoss = adjustedStopLoss.toFixed(3)


                  // Prepare trade parameters
                  const tradeParams = {
                    trader: userSession.address,
                    pairIndex: PAIRS_OBJECT[selectedPair], // Map `selectedPair` to pairIndex
                    index: 0,
                    initialPosToken: 0,
                    positionSizeUSDC: ethers.parseUnits(size, 6),
                    openPrice: ethers.parseUnits(limitPrice, 10),
                    buy: buy, // Buy/Sell direction
                    leverage: ethers.parseUnits(leverage, 10),
                    tp: 0,
                    sl: ethers.parseUnits(trimmed_stopLoss.toString(), 10),
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

                  await bot.sendMessage(slMsg.chat.id, "Check your wallet for approval...");

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

                  await bot.sendMessage(slMsg.chat.id, `Trade transaction submitted! Hash: ${result}\n Waiting for confirmation...`);

                  const mockOrderId = Date.now().toString();
                  await storeTrade(slMsg.chat.id, mockOrderId, result);

                  await bot.sendMessage(slMsg.chat.id, "Trade order stored successfully! Use /opentrades to view your orders.");
                } catch (error) {
                  console.error("Open trade error:", error);
                  await bot.sendMessage(slMsg.chat.id, `Failed to open trade. Error: ${error}`);
                }
              });
            });
          });
        });
      });
    });
  } catch (error) {
    console.error("Handle limit trade error:", error);
    await bot.sendMessage(msg.chat.id, "An error occurred. Please try again.");
  }
}



async function handleMarketTrade(bot, msg) {
  try {
    const userSession = await getUserSession(msg.chat.id);

    if (!userSession || !userSession.topic || !userSession.address) {
      await bot.sendMessage(msg.chat.id, "Please connect your wallet first using /connect");
      return;
    }

    // Step 1: Show trading pairs menu
    showPairsMenu(bot, msg.chat.id, "market");

    // Step 2: Handle pair selection via callback
    bot.once("callback_query", async (callbackQuery) => {
      const { data, message } = callbackQuery;
      const [action, type, selectedPair] = data.split(":");

      if (action !== "select_pair" || type !== "market") {
        await bot.sendMessage(message.chat.id, "Invalid selection. Please try again.");
        return;
      }

      const Price = await price({ id: [feedIds[selectedPair].id] });
      const maxLevearage =  feedIds[selectedPair].leverage || "NaN";


      // Ask for Long or Short
      const options = {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: "Long 🟢", callback_data: `trade_direction:long:${selectedPair}` }],
            [{ text: "Short 🔴", callback_data: `trade_direction:short:${selectedPair}` }],
          ],
        }),
      };

      await bot.sendMessage(message.chat.id, "Do you want to go Long🟢 or Short🔴?", options);

      // Step 3: Handle Long/Short selection
      bot.once("callback_query", async (directionCallback) => {
        const directionData = directionCallback.data.split(":");
        const direction = directionData[1]; // "long" or "short"
        const buy = direction === "long"; // Long => true, Short => false

        await bot.sendMessage(message.chat.id, `You selected ${buy ? "Long 🟢" : "Short 🔴"}. Enter the size in USDC:`);

        // Step 4: Wait for size input
        bot.once("message", async (sizeMsg) => {
          const size = sizeMsg.text;

          if (isNaN(size) || parseFloat(size) <= 0) {
            await bot.sendMessage(sizeMsg.chat.id, "Invalid size. Please enter a valid number.");
            return;
          }

          await bot.sendMessage(sizeMsg.chat.id, `Size: ${size} USDC. Now enter leverage:\nMax leverage for this pair is ${maxLevearage}x`);

          let text;
          if(buy){
            text = `Below the market price of ${parseFloat(Price).toFixed(3)}`
          }else {
            text = `Above the market price of ${Price}`
          }
          // Step 5: Wait for leverage input
          bot.once("message", async (leverageMsg) => {
            const leverage = leverageMsg.text;
           
            if (isNaN(leverage) || parseFloat(leverage) <= 0) {
              await bot.sendMessage(leverageMsg.chat.id, `Invalid leverage. Please enter a valid number. and Max leverage for this pair is ${maxLevearage}x`);
              return;
            }

            await bot.sendMessage(leverageMsg.chat.id, `Leverage: ${leverage}x. Now enter stop-loss (price) 
              \n ${text} }:`);

            // Step 6: Wait for stop-loss input
            bot.once("message", async (slMsg) => {
              const stopLoss = slMsg.text;

              if (isNaN(stopLoss) || parseFloat(stopLoss) <= 0) {
                await bot.sendMessage(slMsg.chat.id, "Invalid stop-loss. Please enter a valid price.");
                return;
              }

              await bot.sendMessage(slMsg.chat.id, `Stop-Loss: ${stopLoss}. Preparing to open trade...`);

              // Step 7: Validate wallet and initiate trade
              try {
                const check_allowance = await CONTRACT_INSTANCE_USDC.allowance(userSession.address, SPENDER_APPROVE);
                const check_balance = await CONTRACT_INSTANCE_USDC.balanceOf(userSession.address);

                if (check_balance < ethers.parseUnits(size.toString(), 6)) {
                  throw `Available Balance: ${ethers.formatUnits(check_balance, 6)}\nRequired Balance: ${size}`;
                }

                if (check_allowance < ethers.parseUnits(size.toString(), 6)) {
                  throw `Allowance of ${ethers.formatUnits(check_allowance, 6)} is less than ${size}, Increase allowance using /approve <amount in $> command`;
                }

                console.log("Returned Stop Loss:",(calculateStopLoss(Price, stopLoss, leverage, buy)).toFixed(3))

                const adjustedStopLoss = (calculateStopLoss(Price, stopLoss, leverage, buy)).toFixed(3);
                //const takeProfit = MAX_TP(Price, leverage, buy);
                console.log("Price",Price,"\n Adjusted stop loss",adjustedStopLoss)
                const tradeParams = {
                  trader: userSession.address,
                  pairIndex: PAIRS_OBJECT[selectedPair], // Map `selectedPair` to pairIndex based on backend logic
                  index: 0,
                  initialPosToken: 0,
                  positionSizeUSDC: ethers.parseUnits(size, 6),
                  openPrice: ethers.parseUnits(Price, 10),
                  buy: buy,
                  leverage: ethers.parseUnits(leverage, 10),
                  tp: 0,
                  sl: ethers.parseUnits(adjustedStopLoss.toString(), 10),
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

                await bot.sendMessage(slMsg.chat.id, "Check your wallet for approval...");

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

                await bot.sendMessage(
                  slMsg.chat.id,
                  `Trade transaction submitted! Hash: ${result}\nWaiting for confirmation...`
                );

                const mockOrderId = Date.now().toString();
                await storeTrade(slMsg.chat.id, mockOrderId, result);

                await bot.sendMessage(slMsg.chat.id, "Trade order stored successfully! Use /opentrades to view your orders.");
              } catch (error) {
                console.error("Open trade error:", error.message);
                await bot.sendMessage(slMsg.chat.id, `Failed to open trade. Error: ${error.message}`);
              }
            });
          });
        });
      });
    });
  } catch (error) {
    console.error("Handle market trade error:", error);
    await bot.sendMessage(msg.chat.id, "An error occurred. Please try again.");
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
        📍 Position Size: ${ethers.formatUnits(trade.initialPosToken, 6)} USDC
        ⚡ Leverage: ${ethers.formatUnits(trade.leverage, 10)}x

        🎯 Trade Markers
        ────────────────────
        🔹 Open Price: ${parseFloat(openPrice).toFixed(4)}$
        💹 Current Price: ${parseFloat(currentPrices).toFixed(4) || "NaN"}$
         
        🚦 Take Profit: ${parseFloat(ethers.formatUnits(trade.tp, 10)).toFixed(4)}$
        ⚠️ Stop Loss: ${parseFloat(ethers.formatUnits(trade.sl, 10)).toFixed(4)}$
        💥 Liquidation: ${parseFloat(ethers.formatUnits(trade.liquidationPrice, 10)).toFixed(4)}$


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

    await bot.sendMessage(query.message.chat.id, `Trade transaction submitted! Hash: ${result}\nWaiting for confirmation...`);

  } catch (error) {
    // console.log(error.message)
    await bot.answerCallbackQuery(query.id, { text: "Failed to close trade. Try again later." });
  }
}

async function handleTradeCloseCallback_limit(bot, query, contractInstance) {
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
  

  try {

    // Execution fee (you may replace this with dynamic calculation if needed)
    const tradeParams = {
      pairIndex: pairIndex, // Map `selectedPair` to pairIndex based on backend logic
      index: tradeIndex,
    };

    console.log(tradeParams)


    // Encode the function call
    const iface = new ethers.Interface(TRADING_ABI);
    const data = iface.encodeFunctionData('cancelOpenLimitOrder', [
        tradeParams.pairIndex,
        tradeParams.index,
    ]);

    await bot.sendMessage(query.message.chat.id, 'Check your wallet for approval...');


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

    await bot.sendMessage(query.message.chat.id, `Trade transaction submitted! Hash: ${result}\nWaiting for confirmation...`);

  } catch (error) {
    // console.log(error.message)
    await bot.answerCallbackQuery(query.id, { text: "Failed to close trade. Try again later." });
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

