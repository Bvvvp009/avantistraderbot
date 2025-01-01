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
const WALLET_CONNECT_SERVICE_URL = 'http://localhost:3000';
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
// Initialize classes




async function initDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // User sessions table - Enhanced for multi-user support
            db.run(`
                CREATE TABLE IF NOT EXISTS user_sessions (
                    chat_id INTEGER PRIMARY KEY,
                    topic TEXT,
                    address TEXT,
                    session_data TEXT,
                    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    connection_status TEXT DEFAULT 'disconnected',
                    retry_count INTEGER DEFAULT 0
                )
            `, (err) => {
                if (err) reject(err);
            });

            // Active trades table with user tracking
            db.run(`
                CREATE TABLE IF NOT EXISTS trades (
                    chat_id INTEGER,
                    order_id TEXT,
                    timestamp INTEGER,
                    tx_hash TEXT,
                    trade_status TEXT DEFAULT 'pending',
                    trade_type TEXT,
                    last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (chat_id, order_id)
                )
            `, (err) => {
                if (err) reject(err);
            });

            // User state tracking table
            db.run(`
                CREATE TABLE IF NOT EXISTS user_states (
                    chat_id INTEGER PRIMARY KEY,
                    current_trade_flow TEXT,
                    trade_data TEXT,
                    last_command TEXT,
                    last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// Store active requests with timestamps and additional metadata
const activeRequests = new Map();

// Timeout duration (5 minutes)
const REQUEST_TIMEOUT = 5 * 60 * 1000;

// Cleanup interval (1 minute)
const CLEANUP_INTERVAL = 60 * 1000;

// Clean up old requests periodically
setInterval(() => {
    const now = Date.now();
    for (const [requestId, data] of activeRequests.entries()) {
        if (now - data.timestamp > REQUEST_TIMEOUT) {
            activeRequests.delete(requestId);
        }
    }
}, CLEANUP_INTERVAL);

async function makeWalletConnectRequest(endpoint, method = 'GET', data = null, chatId = null) {
    try {
        // Always include chatId in requests
        const requestData = method !== 'GET' ? {
            ...data,
            chatId: chatId
        } : data;

        const response = await axios({
            method,
            url: `${WALLET_CONNECT_SERVICE_URL}${endpoint}`,
            data: requestData,
            params: method === 'GET' ? { chatId } : undefined,
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });

        // If this is a trade request, store it in activeRequests
        if (endpoint.includes('/request/') && response.data.result) {
            activeRequests.set(response.data.result, {
                timestamp: Date.now(),
                chatId: chatId,
                endpoint: endpoint,
                type: data?.request?.method || 'unknown',
                status: 'pending'
            });
        }

        // Update last activity timestamp
        if (chatId) {
            await db.run(
                `UPDATE user_sessions 
                 SET last_activity = CURRENT_TIMESTAMP 
                 WHERE chat_id = ?`,
                [chatId]
            );
        }

        return response.data;
    } catch (error) {
        console.error(`WalletConnect service error (${endpoint}):`, 
            error.response?.data || error.message);
        
        // Update retry count and status if needed
        if (chatId) {
            await db.run(
                `UPDATE user_sessions 
                 SET retry_count = retry_count + 1 
                 WHERE chat_id = ?`,
                [chatId]
            );
        }

        throw error;
    }
}

// Function to check if a request is valid
function isValidRequest(txHash, chatId) {
    const requestData = activeRequests.get(txHash);
    if (!requestData) {
        return false; // Request not found
    }

    if (requestData.chatId !== chatId) {
        return false; // Request belongs to different user
    }

    if (Date.now() - requestData.timestamp > REQUEST_TIMEOUT) {
        activeRequests.delete(txHash); // Clean up expired request
        return false;
    }

    return true;
}

// Function to update request status
function updateRequestStatus(txHash, status) {
    const requestData = activeRequests.get(txHash);
    if (requestData) {
        requestData.status = status;
        activeRequests.set(txHash, requestData);
    }
}

// Function to get all active requests for a user
function getUserActiveRequests(chatId) {
    const userRequests = [];
    for (const [txHash, data] of activeRequests.entries()) {
        if (data.chatId === chatId) {
            userRequests.push({
                txHash,
                ...data
            });
        }
    }
    return userRequests;
}

// Function to cancel specific request
async function cancelWalletConnectRequest(txHash, chatId) {
    const requestData = activeRequests.get(txHash);
    if (requestData && requestData.chatId === chatId) {
        try {
            // Attempt to cancel on WalletConnect service if needed
            await axios({
                method: 'POST',
                url: `${WALLET_CONNECT_SERVICE_URL}/cancel/${txHash}`,
                data: { chatId },
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
        } catch (error) {
            console.error('Error canceling request:', error);
        } finally {
            activeRequests.delete(txHash);
            return true;
        }
    }
    return false;
}

// Function to cancel all requests for a user
async function cancelAllUserRequests(chatId) {
    const userRequests = getUserActiveRequests(chatId);
    for (const request of userRequests) {
        await cancelWalletConnectRequest(request.txHash, chatId);
    }
}


// Bot state management utilities
const userTradeFlows = new Map(); // Track active trade flows per user
const userCallbacks = new Map();  // Track active callbacks per user

async function initBot() {
  try {
    await initDatabase();
    await cleanupInactiveSessions(); // Clean old sessions on startup
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });

    // Command handlers with session checks
    const commandHandlers = {
      '/start': handleStart,
      '/connect': handleConnect,
      '/openlimit': handleLimitTrade,
      '/trades': handleViewTrades,
      '/openmarket': handleMarketTrade,
      '/verify': handleVerifyConnection,
      '/opentrades': handleGetTrades,
      '/disconnect': handleDisconnect
    };

    // Register command handlers with session management
    Object.entries(commandHandlers).forEach(([command, handler]) => {
      bot.onText(new RegExp(`^${command}$`), async (msg) => {
        const chatId = msg.chat.id;
        try {
          // Clear any existing trade flows for new commands
          if (command !== '/openlimit' && command !== '/openmarket') {
            userTradeFlows.delete(chatId);
          }
          await handler(bot, msg);
        } catch (error) {
          console.error(`Error in ${command}:`, error);
          await bot.sendMessage(chatId, 'An error occurred. Please try again.');
        }
      });
    });

    // Handle /approve command with amount
    bot.onText(/^\/approve\s+(\d+(?:\.\d+)?)$/, async (msg, match) => {
      const chatId = msg.chat.id;
      try {
        const amount = match[1];
        const approveMsg = { ...msg, text: `/approve ${amount}` };
        await handleApprove(bot, approveMsg);
      } catch (error) {
        console.error("Error during approval:", error);
        await bot.sendMessage(chatId, "❌ Failed to process approval. Please try again.");
      }
    });

    // Enhanced callback query handler with user state management
    bot.on("callback_query", async (query) => {
      const chatId = query.message.chat.id;
      
      try {
        // Store callback in user map
        userCallbacks.set(chatId, query);

        if (query.data.startsWith("close_trade:")) {
          await handleTradeCloseCallback(bot, query, CONTRACT_INSTANCE_TRADING);
        } else if (query.data.startsWith("close_limit_trade:")) {
          await handleTradeCloseCallback_limit(bot, query, CONTRACT_INSTANCE_TRADING);
        } else if (query.data.startsWith("close_partial:")) {
          const [action, pairIndex, tradeIndex, positionSize] = query.data.split(":");
          await handlePartialClose(bot, query, pairIndex, tradeIndex, positionSize);
        }

      } catch (error) {
        console.error("Callback query error:", error);
        await bot.sendMessage(chatId, "Error processing your request. Please try again.");
      } finally {
        // Clean up callback
        userCallbacks.delete(chatId);
      }
    });

    // Set up command list
    await bot.setMyCommands([
      { command: '/start', description: 'Start the bot' },
      { command: '/connect', description: 'Connect your wallet' },
      { command: '/verify', description: 'Verify wallet connection' },
      { command: '/openlimit', description: 'Open a new Limit order' },
      { command: '/opentrades', description: 'View your recent trades' },
      { command: '/approve', description: 'Approve spending limit' },
      { command: '/openmarket', description: 'Open a Market trade' },
      { command: '/disconnect', description: 'Disconnect wallet' },
    ]);

    // Error handler for bot instance
    bot.on('polling_error', async (error) => {
      console.error('Bot polling error:', error);
      // Attempt to restart polling
      try {
        await bot.stopPolling();
        await new Promise(resolve => setTimeout(resolve, 5000));
        await bot.startPolling();
      } catch (e) {
        console.error('Failed to restart polling:', e);
      }
    });

    // Set up periodic session cleanup
    setInterval(async () => {
      try {
        await cleanupInactiveSessions();
        // Clean up stale trade flows
        for (const [chatId, flow] of userTradeFlows.entries()) {
          if (Date.now() - flow.timestamp > 30 * 60 * 1000) { // 30 minutes timeout
            userTradeFlows.delete(chatId);
          }
        }
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }, 60 * 60 * 1000); // Run every hour

    return bot;

  } catch (error) {
    console.error('Bot initialization failed:', error);
    throw error;
  }
}

async function handlePartialClose(bot, query, pairIndex, tradeIndex, positionSize) {
    const chatId = query.message.chat.id;

    try {
        const userSession = await getUserSession(chatId);
        if (!userSession || !userSession.address) {
            await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
            return;
        }

        // Store partial close state
        await saveUserState(chatId, 'partial_close', {
            pairIndex,
            tradeIndex,
            positionSize,
            timestamp: Date.now()
        });

        await bot.sendMessage(
            chatId,
            `You selected to partially close your position.\n` +
            `💼 Current Position Size: ${positionSize} USDC\n` +
            `🔢 Please enter the size to close:`
        );

        // Handle size input for partial close
        bot.once("message", async (sizeMsg) => {
            if (sizeMsg.chat.id !== chatId) return;

            const partialSize = parseFloat(sizeMsg.text);

            // Validate partial close size
            if (isNaN(partialSize) || partialSize <= 0 || partialSize > parseFloat(positionSize)) {
                await bot.sendMessage(
                    chatId, 
                    "Invalid size. Please enter a valid number less than or equal to your position size."
                );
                await clearUserState(chatId);
                return;
            }

            try {
                // Execute partial close
                await handleTradeCloseCallback(bot, query, null, partialSize);
                
                // Update state after successful partial close
                const updatedSize = parseFloat(positionSize) - partialSize;
                await updatePartialCloseState(chatId, query.data, updatedSize);
                
            } catch (error) {
                console.error("Error during partial close:", error);
                await bot.sendMessage(
                    chatId, 
                    "❌ Failed to process partial close. Please try again later."
                );
                await clearUserState(chatId);
            }
        });

    } catch (error) {
        console.error("Partial close error:", error);
        await bot.sendMessage(
            chatId,
            "Error processing partial close. Please try again."
        );
        await clearUserState(chatId);
    }
}

// Update callback data after partial close
async function updatePartialCloseState(chatId, callbackData, remainingSize) {
    const [action, pairIndex, tradeIndex] = callbackData.split(":");
    const newCallbackData = `${action}:${pairIndex}:${tradeIndex}:${remainingSize}`;
    
    // Update in database
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE trades 
             SET trade_data = json_set(trade_data, '$.size', ?) 
             WHERE chat_id = ? AND order_id LIKE ?`,
            [remainingSize, chatId, `%${tradeIndex}`],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
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
  
  async function handleDisconnect(bot, msg) {
    try {
      const chatId = msg.chat.id;
      const existingSession = await getUserSession(chatId);
      
      if (existingSession && existingSession.topic) {
        try {
          const session = await makeWalletConnectRequest(
            `/session/${existingSession.topic}`,
            'DELETE',
            null,
            chatId
          );
  
          if (session.success) {
            // Update database status
            await db.run(
              `UPDATE user_sessions 
               SET connection_status = 'disconnected', 
                   last_activity = CURRENT_TIMESTAMP 
               WHERE chat_id = ?`,
              [chatId]
            );
  
            await bot.sendMessage(
              chatId,
              `Your wallet session has been disconnected.\n` +
              `To start a new session, please use the /connect command.`
            );
          }
        } catch (error) {
          console.error('Error disconnecting existing session:', error);
          throw error;
        }
      } else {
        await bot.sendMessage(chatId, 'No active session found.');
      }
    } catch (error) {
      await bot.sendMessage(msg.chat.id, 'Error occurred while disconnecting. Please try again.');
    }
  }

  async function handleConnect(bot, msg) {
    try {
        const chatId = msg.chat.id;
        
        // Get existing session if any
        const existingSession = await getUserSession(chatId);
        if (existingSession?.topic) {
            await makeWalletConnectRequest(
                `/session/${existingSession.topic}`, 
                'DELETE', 
                null, 
                chatId
            );
        }

        // Initialize new connection
        const { uri, topic } = await makeWalletConnectRequest('/connect', 'POST', null, chatId);

        if (!uri) throw new Error('No URI received from wallet connect');
      if (uri) {
        // Generate QR Code
        const qrCodeImage = await QRCode.toBuffer(uri);
        
        // Base redirect URL
        const baseRedirectUrl = 'https://bvvvp009.github.io/wallet-connect-reconnect/redirect.html';
        
        const walletLinks = [
          { name: 'MetaMask', redirectScheme: 'metamask', icon: '🦊' },
          { name: 'Trust Wallet', redirectScheme: 'trust', icon: '🛡' },
          { name: 'Other wallets', redirectScheme: 'safe', icon: '👜' }
        ];
  
        const walletLinksText = walletLinks
          .map(wallet => 
            `${wallet.icon} [Connect with ${wallet.name}](${baseRedirectUrl}?wallet=${wallet.redirectScheme}&uri=${encodeURIComponent(uri)})`
          )
          .join('\n');
  
        // Escape Markdown for raw URI
        const escapedUri = uri.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  
        // Send QR code with instructions
        const qrMessage = await bot.sendPhoto(chatId, qrCodeImage, {
          caption:
            `Scan the QR Code or Quick Connect:\n\n` +
            `${walletLinksText}\n\n` +
            `OR directly paste this URI in your wallet:\n\`${escapedUri}\``,
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: walletLinks.map(wallet => [{
              text: `${wallet.icon} Connect ${wallet.name}`,
              url: `${baseRedirectUrl}?wallet=${wallet.redirectScheme}&uri=${encodeURIComponent(uri)}`
            }])
          }
        });
  
        const statusMessage = await bot.sendMessage(
          chatId,
          `Please select a wallet to connect.\n` +
          `This session will remain active for only 1 minute.\n` +
          `If this session expires, you can restart it anytime using /connect command.`
        );
  
         // Poll for session status with improved error handling
         const pollSessionStatus = async (attempts = 0, maxAttempts = 30) => {
            if (attempts >= maxAttempts) {
                throw new Error('Connection timeout');
            }

            const statusResponse = await makeWalletConnectRequest(
                `/session-status/${topic}`,
                'GET',
                null,
                chatId
            );

            if (statusResponse.status === 'connected') {
                const { session } = await makeWalletConnectRequest(
                    `/session/${statusResponse.topic}`,
                    'GET',
                    null,
                    chatId
                );
                
                const address = session.namespaces.eip155.accounts[0].split(':')[2];
                return { session, address };
            }

            if (statusResponse.status === 'failed') {
                throw new Error('Connection failed');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
            return pollSessionStatus(attempts + 1, maxAttempts);
        };

        const { session, address } = await pollSessionStatus();
        
        await saveUserSession(
            chatId,
            session.topic,  // Use the topic from status response
            address,
            JSON.stringify({
                ...session,
                address,
                status: 'connected'
            })
        );
        // Session established successfully
        await bot.editMessageText(
            `Wallet connected successfully!\nAddress: ${address}\nYou can now use /openmarket to place orders.`,
            {
                chat_id: chatId,
                message_id: statusMessage.message_id
            })
      }
    } catch (error) {
      console.error('Connection error:', error);
      await bot.sendMessage(msg.chat.id, 'Failed to connect wallet. Please try again.');
    }
  }
  

  async function handleVerifyConnection(bot, msg) {
  const chatId = msg.chat.id;
  const userSession = await getUserSession(chatId);
    console.log(userSession,chatId)
  try {
    if (!userSession || !userSession.topic) {
      await bot.sendMessage(chatId, 'No active session found. Please connect using /connect');
      return;
    }

    const { session } = await makeWalletConnectRequest(
      `/session/${userSession.topic}`,
      'GET',
      null,
      chatId
    );

    if (session) {
      // Update last activity
      await db.run(
        `UPDATE user_sessions 
         SET last_activity = CURRENT_TIMESTAMP 
         WHERE chat_id = ?`,
        [chatId]
      );

      await bot.sendMessage(
        chatId,
        `Session verified ✅\nWallet: ${userSession.address}\nStatus: Connected`
      );
    }
  } catch (error) {
    console.error('Verification error:', error);
    await bot.sendMessage(
      chatId,
      'Your wallet session has expired. Please reconnect using /connect'
    );
    
    // Update session status
    await db.run(
      `UPDATE user_sessions 
       SET connection_status = 'disconnected' 
       WHERE chat_id = ?`,
      [chatId]
    );
  }
}

async function handleApprove(bot, msg, tradeState = null) {
    const chatId = msg.chat.id;
    const [, amount] = msg.text.split(' ');

    if (!amount) {
        await bot.sendMessage(chatId, 'Please provide amount to spend: /approve <amount>');
        return false;
    }

    try {
        const userSession = await getUserSession(chatId);
        if (!userSession || !userSession.topic || !userSession.address) {
            await bot.sendMessage(chatId, 'Please connect your wallet first using /connect');
            return false;
        }

        // Store approve flow state
        await saveUserState(chatId, 'approve', {
            amount,
            timestamp: Date.now()
        });

        // Get current allowance
        const currentAllowance = await CONTRACT_INSTANCE_USDC.allowance(
            userSession.address, 
            SPENDER_APPROVE
        );

        // Verify session is still active
        try {
            await makeWalletConnectRequest(
                `/session/${userSession.topic}`, 
                'GET', 
                null, 
                chatId
            );
        } catch (error) {
            await bot.sendMessage(chatId, 'Your wallet session has expired. Please reconnect using /connect');
            return false;
        }

        const parseAmount = parseFloat(amount);
        if (isNaN(parseAmount) || parseAmount <= 0) {
            await bot.sendMessage(chatId, 'Invalid amount. Please enter a positive number.');
            return false;
        }

        const userBalance = await CONTRACT_INSTANCE_USDC.balanceOf(userSession.address);
        const requestedAllowance = ethers.parseUnits(amount.toString(), 6);

        if (userBalance < requestedAllowance) {
            await bot.sendMessage(chatId, 
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

        const initialMessage = await bot.sendMessage(chatId, 
            `Requesting approval for ${amount} USDC\n` +
            `Spender: ${SPENDER_APPROVE}\n` +
            'Please check your wallet for approval...'
        );

        // Send request with chatId
        const { result } = await makeWalletConnectRequest(
            `/request/${userSession.topic}`, 
            'POST', 
            {
                chainId: `eip155:${BASE_CHAIN_ID}`,
                request: {
                    method: 'eth_sendTransaction',
                    params: [{
                        from: userSession.address,
                        to: USDC_CONTRACT_ON_BASE,
                        data: data,
                        value: '0x0'
                    }]
                }
            },
            chatId
        );

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
                            const newAllowance = await CONTRACT_INSTANCE_USDC.allowance(
                                userSession.address, 
                                SPENDER_APPROVE
                            );

                            await bot.editMessageText(
                                `Approval Confirmed! ✅\n` +
                                `Transaction Hash: ${result}\n` +
                                `Confirmations: ${confirmations}\n` +
                                `New Allowance: ${ethers.formatUnits(newAllowance, 6)} USDC`,
                                {
                                    chat_id: chatId,
                                    message_id: initialMessage.message_id
                                }
                            );

                            // Update user state and continue with trade if needed
                            if (tradeState) {
                                await saveUserState(chatId, 'trade', tradeState);
                                await bot.sendMessage(chatId, 
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
                                chat_id: chatId,
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
        await bot.sendMessage(chatId, `Failed to process approval. Error: ${error.message || ''}`);
        return false;
    }
}


// User state management
const userTradeStates = new Map();

// Transaction queue implementation
class TransactionQueue {
    constructor() {
        this.queues = new Map();
    }
    
    async addTransaction(userId, transaction) {
        if (!this.queues.has(userId)) {
            this.queues.set(userId, []);
        }
        
        const userQueue = this.queues.get(userId);
        userQueue.push(transaction);
        
        if (userQueue.length === 1) {
            await this.processQueue(userId);
        }
    }
    
    async processQueue(userId) {
        const userQueue = this.queues.get(userId);
        
        while (userQueue.length > 0) {
            const transaction = userQueue[0];
            try {
                await transaction();
            } catch (error) {
                console.error(`Transaction failed for user ${userId}:`, error);
            }
            userQueue.shift();
        }
    }
}

const txQueue = new TransactionQueue();

// Helper function to create user-specific event handlers
function createUserSpecificHandler(bot, chatId, eventType, handler) {
    const wrappedHandler = async (event) => {
        if (event.chat?.id === chatId || event.message?.chat.id === chatId) {
            try {
                await handler(event);
            } finally {
                bot.removeListener(eventType, wrappedHandler);
            }
        }
    };
    return wrappedHandler;
}

// Main limit trade handler
async function handleLimitTrade(bot, msg) {
    const chatId = msg.chat.id;
    try {
        const userSession = await getUserSession(chatId);
        if (!userSession || !userSession.topic || !userSession.address) {
            await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
            return;
        }

        // Initialize user-specific trade state
        const tradeState = {
            selectedPair: null,
            size: null,
            leverage: null,
            buy: null,
            price: null,
            limitPrice: null,
            stopLoss: null,
            takeProfit: null,
            stage: 'pair_selection'
        };

        // Save initial state
        await saveUserState(chatId, 'limit_trade', tradeState);
        userTradeStates.set(chatId, tradeState);

        // Show pairs menu
         showPairsMenu(bot, chatId, "limit");

        // Create and attach pair selection handler
        const pairSelectionHandler = createUserSpecificHandler(
            bot,
            chatId,
            'callback_query',
            async (callbackQuery) => {
                const { data, message } = callbackQuery;
                const [action, type, selectedPair] = data.split(":");

                if (action !== "select_pair" || type !== "limit") {
                    await bot.sendMessage(chatId, "Invalid selection. Please try again.");
                    return;
                }

                try {
                    // Update trade state with selected pair
                    const currentState = userTradeStates.get(chatId);
                    currentState.selectedPair = selectedPair;
                    currentState.price = await price({ id: [feedIds[selectedPair].id] });
                    const maxLeverage = feedIds[selectedPair].leverage || "NaN";
                    currentState.maxLeverage = maxLeverage;
                    currentState.stage = 'direction_selection';
                    
                    await saveUserState(chatId, 'limit_trade', currentState);

                    // Show direction options
                    const options = {
                        reply_markup: JSON.stringify({
                            inline_keyboard: [
                                [{ text: "Long 🟢", callback_data: `trade_direction:long:${selectedPair}` }],
                                [{ text: "Short 🔴", callback_data: `trade_direction:short:${selectedPair}` }],
                            ],
                        }),
                    };

                    await bot.sendMessage(chatId, "Do you want to go Long🟢 or Short🔴?", options);

                    // Create and attach direction selection handler
                    const directionHandler = createUserSpecificHandler(
                        bot,
                        chatId,
                        'callback_query',
                        async (directionCallback) => {
                            const directionData = directionCallback.data.split(":");
                            const direction = directionData[1];
                            currentState.buy = direction === "long";
                            currentState.stage = 'size_input';
                            
                            await saveUserState(chatId, 'limit_trade', currentState);
                            await handleLimitTradeSize(bot, chatId, currentState);
                        }
                    );

                    bot.on('callback_query', directionHandler);

                } catch (error) {
                    console.error("Error in pair selection:", error);
                    await bot.sendMessage(chatId, "Error processing selection. Please try again.");
                }
            }
        );

        bot.on('callback_query', pairSelectionHandler);

    } catch (error) {
        console.error("Handle limit trade error:", error);
        await bot.sendMessage(chatId, "Failed to open limit trade. Please try again.");
        await clearUserState(chatId);
        userTradeStates.delete(chatId);
    }
}

async function handleLimitTradeSize(bot, chatId, tradeState) {
    await bot.sendMessage(
        chatId, 
        `You selected ${tradeState.buy ? "Long 🟢" : "Short 🔴"}. Enter the size in USDC:`
    );

    const sizeHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (sizeMsg) => {
            const size = sizeMsg.text;
            if (isNaN(size) || parseFloat(size) <= 0) {
                await bot.sendMessage(chatId, "Invalid size. Please enter a valid number.");
                return;
            }

            try {
                const userSession = await getUserSession(chatId);
                const check_balance = await CONTRACT_INSTANCE_USDC.balanceOf(userSession.address);
                const check_allowance = await CONTRACT_INSTANCE_USDC.allowance(
                    userSession.address, 
                    SPENDER_APPROVE
                );
                const requiredAmount = ethers.parseUnits(size.toString(), 6);
                
                tradeState.size = parseFloat(size);
                tradeState.stage = 'approval_check';
                await saveUserState(chatId, 'limit_trade', tradeState);

                if (check_balance < requiredAmount) {
                    await bot.sendMessage(chatId, 
                        `Insufficient balance!\n` +
                        `Available Balance: ${ethers.formatUnits(check_balance, 6)} USDC\n` +
                        `Required Amount: ${size} USDC`
                    );
                    return;
                }

                if (check_allowance < requiredAmount) {
                    await handleLimitInsufficientAllowance(
                        bot,
                        sizeMsg,
                        check_allowance,
                        size,
                        tradeState
                    );
                } else {
                    await handleLimitLeverageInput(bot, chatId, tradeState);
                }

            } catch (error) {
                console.error("Trade processing error:", error);
                await bot.sendMessage(chatId, "Error processing trade. Please try again.");
            }
        }
    );

    bot.on('message', sizeHandler);
}

async function handleLimitInsufficientAllowance(bot, sizeMsg, check_allowance, size, tradeState) {
    const chatId = sizeMsg.chat.id;
    const neededApproval = ethers.formatUnits(
        ethers.parseUnits(size.toString(), 6),
        6
    );
    
    const approveOptions = {
        reply_markup: JSON.stringify({
            inline_keyboard: [
                [{ text: "📝 Approve USDC", callback_data: `approve:${neededApproval}` }],
                [{ text: "❌ Cancel", callback_data: "approve:cancel" }],
            ],
        }),
    };

    await bot.sendMessage(chatId, 
        `⚠️ Insufficient Approval!\n\n` +
        `Current Allowance: ${ethers.formatUnits(check_allowance, 6)} USDC\n` +
        `Required Amount: ${size} USDC\n` +
        `Additional Needed: ${neededApproval} USDC`, 
        approveOptions
    );

    const approveHandler = createUserSpecificHandler(
        bot,
        chatId,
        'callback_query',
        async (approveCallback) => {
            const [action, value] = approveCallback.data.split(":");
            
            if (action === "approve" && value !== "cancel") {
                const approveMsg = {
                    chat: { id: chatId },
                    text: `/approve ${value}`
                };

                const approvalSuccess = await handleApprove(bot, approveMsg, tradeState);
                
                if (!approvalSuccess) {
                    await bot.sendMessage(chatId, "Approval failed or was rejected. Please try again /openlimit");
                    return;
                }

                await handleLimitLeverageInput(bot, chatId, tradeState);
            } else {
                await bot.sendMessage(chatId, "Trade cancelled. Use /openlimit to start again.");
                await clearUserState(chatId);
                userTradeStates.delete(chatId);
            }
        }
    );

    bot.on('callback_query', approveHandler);
}

async function handleLimitLeverageInput(bot, chatId, tradeState) {
    await bot.sendMessage(
        chatId, 
        `Size: ${tradeState.size} USDC. Now enter leverage:\n` +
        `Max leverage for this pair is ${tradeState.maxLeverage}x`
    );

    const leverageHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (leverageMsg) => {
            const leverage = leverageMsg.text;
            
            if (isNaN(leverage) || parseFloat(leverage) <= 0 || parseFloat(leverage) > tradeState.maxLeverage) {
                await bot.sendMessage(
                    chatId, 
                    `Invalid leverage. Please enter a valid number between 1 and ${tradeState.maxLeverage}x`
                );
                return;
            }

            tradeState.leverage = parseFloat(leverage);
            tradeState.stage = 'limit_price_input';
            await saveUserState(chatId, 'limit_trade', tradeState);

            let text = tradeState.buy
                ? `Below ${tradeState.price > 1 ? parseFloat(tradeState.price).toFixed(2) : parseFloat(tradeState.price).toFixed(4)} $.`
                : `Above ${tradeState.price > 1 ? parseFloat(tradeState.price).toFixed(2) : parseFloat(tradeState.price).toFixed(4)} $.`;

            await bot.sendMessage(
                chatId, 
                `**Leverage: ${leverage}x**\n` +
                `Present Trading price of selected pair: ${parseFloat(tradeState.price).toFixed(2)}$\n` +
                `Enter the Limit Price ${text}`
            );

            await handleLimitPriceInput(bot, chatId, tradeState);
        }
    );

    bot.on('message', leverageHandler);
}

async function handleLimitPriceInput(bot, chatId, tradeState) {
    const priceHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (limitPriceMsg) => {
            const limitPrice = limitPriceMsg.text;
            if (isNaN(limitPrice) || parseFloat(limitPrice) <= 0) {
                await bot.sendMessage(chatId, "Invalid limit price. Please enter a valid number.");
                return;
            }

            tradeState.limitPrice = parseFloat(limitPrice);
            tradeState.stage = 'sl_tp_selection';
            await saveUserState(chatId, 'limit_trade', tradeState);

            const slTpOptions = {
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [{ text: "Yes", callback_data: "set_sl_tp:yes" }],
                        [{ text: "No", callback_data: "set_sl_tp:no" }],
                    ],
                }),
            };

            await bot.sendMessage(chatId, "Would you like to set Stop Loss and Take Profit?", slTpOptions);
            await handleLimitSLTPSetup(bot, chatId, tradeState);
        }
    );

    bot.on('message', priceHandler);
}

async function handleLimitSLTPSetup(bot, chatId, tradeState) {
    const slTpHandler = createUserSpecificHandler(
        bot,
        chatId,
        'callback_query',
        async (slTpCallback) => {
            const [action, value] = slTpCallback.data.split(":");
            
            if (value === "yes") {
                tradeState.stage = 'stop_loss_input';
                await saveUserState(chatId, 'limit_trade', tradeState);
                
                await bot.sendMessage(
                    chatId,
                    `Enter Stop Loss price (or 'skip' to skip):\n` +
                    `Set Stoploss ${tradeState.buy ? 'Below' : 'Above'}, Your Limit Price ${
                        tradeState.limitPrice > 1
                        ? parseFloat(tradeState.limitPrice).toFixed(2)
                        : parseFloat(tradeState.limitPrice).toFixed(2)
                    }$\n`
                );

                await handleLimitStopLossInput(bot, chatId, tradeState);
            } else {
                tradeState.stopLoss = 0;
                tradeState.takeProfit = 0;
                tradeState.stage = 'execution';
                await saveUserState(chatId, 'limit_trade', tradeState);
                
                await bot.sendMessage(chatId, "Please check your wallet for trade confirmation ");
                await txQueue.addTransaction(chatId, async () => {
                    await proceedWithLimitTrade(
                        bot,
                        chatId,
                        tradeState.selectedPair,
                        tradeState.size,
                        tradeState.leverage,
                        tradeState.limitPrice,
                        tradeState.price,
                        tradeState.buy,
                        0,
                        0
                    );
                });
            }
        }
    );

    bot.on('callback_query', slTpHandler);
}

async function handleLimitStopLossInput(bot, chatId, tradeState) {
    const slHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (slMsg) => {
            if (slMsg.text.toLowerCase() === 'skip') {
                tradeState.stopLoss = 0;
            } else {
                const stopLoss = parseFloat(slMsg.text);
                if (isNaN(stopLoss) || stopLoss <= 0) {
                    await bot.sendMessage(chatId, "Invalid Stop Loss. Please try again /openlimit");
                    return;
                }
                tradeState.stopLoss = stopLoss;
            }

            tradeState.stage = 'take_profit_input';
            await saveUserState(chatId, 'limit_trade', tradeState);

            await bot.sendMessage(
                chatId,
                `Enter Take Profit price (or 'skip' to skip):\n` +
                `Set Take Profit ${tradeState.buy ? 'Above' : 'Below'} Limit Price ${
                    tradeState.limitPrice > 1
                    ? parseFloat(tradeState.limitPrice).toFixed(2)
                    : parseFloat(tradeState.limitPrice).toFixed(2)
                }$\n`
            );

            await handleLimitTakeProfitInput(bot, chatId, tradeState);
        }
    );

    bot.on('message', slHandler);
}

async function handleLimitTakeProfitInput(bot, chatId, tradeState) {
    const tpHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (tpMsg) => {
            if (tpMsg.text.toLowerCase() === 'skip') {
                tradeState.takeProfit = 0;
            } else {
                const takeProfit = parseFloat(tpMsg.text);
                if (isNaN(takeProfit) || takeProfit <= 0) {
                    await bot.sendMessage(chatId, "Invalid Take Profit. Please try again /openlimit");
                    return;
                }
                tradeState.takeProfit = takeProfit;
            }

            tradeState.stage = 'execution';
            await saveUserState(chatId, 'limit_trade', tradeState);

            await bot.sendMessage(chatId, "Please check your wallet for trade confirmation...");
            await txQueue.addTransaction(chatId, async () => {
                await proceedWithLimitTrade(
                    bot,
                    chatId,
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
        }
    );

    bot.on('message', tpHandler);
}

async function proceedWithLimitTrade(bot, chatId, selectedPair, size, leverage, limitPrice, currentPrice, buy, stopLoss, takeProfit) {
    try {
        const userSession = await getUserSession(chatId);
        if (!userSession) throw new Error("Session not found");

        // Calculate adjusted stop-loss
        const adjustedStopLoss = stopLoss 
            ? (calculateStopLoss(limitPrice, stopLoss, leverage, buy)).toFixed(3)
            : "0";

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
        const slippageP = ethers.parseUnits("1", 10);
        const executionFee = 0;

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

        // Send transaction request with chatId
        const { result } = await makeWalletConnectRequest(
            `/request/${userSession.topic}`,
            "POST",
            {
                chainId: `eip155:${BASE_CHAIN_ID}`,
                request: {
                    method: "eth_sendTransaction",
                    params: [{
                        from: userSession.address,
                        to: CONTRACT_ADDRESS_TRADING,
                        data: data,
                        value: "0x0",
                    }],
                }
            },
            chatId
        );

        const initialMessage = await bot.sendMessage(
            chatId,
            `Limit trade transaction submitted! Hash: ${result}\n` +
            `Waiting for blockchain confirmation...`
        );

        await monitorLimitTradeConfirmation(bot, chatId, result, initialMessage.message_id);

    } catch (error) {
        console.error("Open limit trade error:", error.message);
        await bot.sendMessage(chatId, `Failed to open limit trade. Error: ${error.response?.data?.message || error.message}`);
        await clearUserState(chatId);
        userTradeStates.delete(chatId);
    }
}

async function monitorLimitTradeConfirmation(bot, chatId, txHash, messageId) {
    const startTime = Date.now();
    const maxWaitTime = 2 * 60 * 1000; // 2 minutes timeout

    const checkConfirmations = async () => {
        try {
            const receipt = await Provider.getTransactionReceipt(txHash);
            
            if (receipt) {
                const currentBlock = await Provider.getBlockNumber();
                const confirmations = currentBlock - receipt.blockNumber;

                if (confirmations >= 3) {
                    // Store trade in database
                    await storeTrade(chatId, txHash, {
                        type: 'limit',
                        status: 'pending',
                        timestamp: Date.now()
                    });

                    await bot.editMessageText(
                        `Limit Order Confirmed! ✅\n` +
                        `Transaction Hash: ${txHash}\n` +
                        `Confirmations: ${confirmations}\n` +
                        `Check your trades using /opentrades.`,
                        {
                            chat_id: chatId,
                            message_id: messageId
                        }
                    );
                    
                    // Clear trade state after successful execution
                    await clearUserState(chatId);
                    userTradeStates.delete(chatId);
                    return;
                }
            }

            if (Date.now() - startTime < maxWaitTime) {
                setTimeout(() => checkConfirmations(), 5000);
            } else {
                await bot.editMessageText(
                    `Limit Order transaction timed out. Please check /opentrades to verify status.\n` +
                    `Transaction Hash: ${txHash}`,
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );
            }
        } catch (error) {
            console.error("Limit trade confirmation check error:", error);
            await bot.editMessageText(
                `Error checking Limit Order status. Please check /opentrades to verify status.\n` +
                `Transaction Hash: ${txHash}`,
                {
                    chat_id: chatId,
                    message_id: messageId
                }
            );
        }
    };

    await checkConfirmations();
}


// Helper function to store trade in database with more details
async function storeTrade(chatId, txHash, tradeDetails) {
    return new Promise((resolve, reject) => {
        const timestamp = Math.floor(Date.now() / 1000);
        db.run(
            `INSERT INTO trades (
                chat_id, 
                order_id, 
                timestamp, 
                tx_hash, 
                trade_status,
                trade_type,
                trade_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                chatId,
                `${tradeDetails.type}_${timestamp}`,
                timestamp,
                txHash,
                tradeDetails.status,
                tradeDetails.type,
                JSON.stringify(tradeDetails)
            ],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}


// Helper function to clean up user state
async function clearUserState(chatId) {
    try {
        await db.run(
            'DELETE FROM user_states WHERE chat_id = ?',
            [chatId]
        );
    } catch (error) {
        console.error('Error clearing user state:', error);
    }
}

// Helper function to get user state
async function getUserState(chatId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT current_trade_flow, trade_data FROM user_states WHERE chat_id = ?',
            [chatId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row ? {
                    type: row.current_trade_flow,
                    data: JSON.parse(row.trade_data)
                } : null);
            }
        );
    });
}

// User state management
const userMarketStates = new Map();

const txQueueMarket = new TransactionQueue();

// Helper function to create user-specific event handlers
function createUserSpecificHandler(bot, chatId, eventType, handler) {
    const wrappedHandler = async (event) => {
        if (event.chat?.id === chatId || event.message?.chat.id === chatId) {
            try {
                await handler(event);
            } finally {
                bot.removeListener(eventType, wrappedHandler);
            }
        }
    };
    return wrappedHandler;
}

// Main market trade handler
async function handleMarketTrade(bot, msg) {
    const chatId = msg.chat.id;
    try {
        const userSession = await getUserSession(chatId);
        if (!userSession || !userSession.topic || !userSession.address) {
            await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
            return;
        }

        // Initialize user-specific trade state
        const tradeState = {
            selectedPair: null,
            size: null,
            leverage: null,
            buy: null,
            price: null,
            stopLoss: null,
            takeProfit: null,
            maxLeverage: null,
            stage: 'pair_selection'
        };

        // Save initial state
        await saveUserState(chatId, 'market_trade', tradeState);
        userMarketStates.set(chatId, tradeState);

        // Show pairs menu
         showPairsMenu(bot, chatId, "market");

        // Create and attach pair selection handler
        const pairSelectionHandler = createUserSpecificHandler(
            bot,
            chatId,
            'callback_query',
            async (callbackQuery) => {
                const { data, message } = callbackQuery;
                const [action, type, selectedPair] = data.split(":");

                if (action !== "select_pair" || type !== "market") {
                    await bot.sendMessage(chatId, "Invalid selection. Please try again.");
                    return;
                }

                try {
                    // Update trade state with selected pair
                    const currentState = userMarketStates.get(chatId);
                    currentState.selectedPair = selectedPair;
                    currentState.price = await price({ id: [feedIds[selectedPair].id] });
                    const maxLeverage = feedIds[selectedPair].leverage || "NaN";
                    currentState.maxLeverage = maxLeverage;
                    currentState.stage = 'direction_selection';
                    
                    await saveUserState(chatId, 'market_trade', currentState);

                    // Show direction options
                    const options = {
                        reply_markup: JSON.stringify({
                            inline_keyboard: [
                                [{ text: "Long 🟢", callback_data: `trade_direction:long:${selectedPair}` }],
                                [{ text: "Short 🔴", callback_data: `trade_direction:short:${selectedPair}` }],
                            ],
                        }),
                    };

                    await bot.sendMessage(chatId, "Do you want to go Long🟢 or Short🔴?", options);

                    // Create and attach direction selection handler
                    const directionHandler = createUserSpecificHandler(
                        bot,
                        chatId,
                        'callback_query',
                        async (directionCallback) => {
                            const directionData = directionCallback.data.split(":");
                            const direction = directionData[1];
                            currentState.buy = direction === "long";
                            currentState.stage = 'size_input';
                            
                            await saveUserState(chatId, 'market_trade', currentState);
                            await handleMarketTradeSize(bot, chatId, currentState);
                        }
                    );

                    bot.on('callback_query', directionHandler);

                } catch (error) {
                    console.error("Error in pair selection:", error);
                    await bot.sendMessage(chatId, "Error processing selection. Please try again.");
                }
            }
        );

        bot.on('callback_query', pairSelectionHandler);

    } catch (error) {
        console.error("Handle market trade error:", error);
        await bot.sendMessage(chatId, "Failed to open market trade. Please try again.");
        await clearUserState(chatId);
        userMarketStates.delete(chatId);
    }
}

async function handleMarketTradeSize(bot, chatId, tradeState) {
    await bot.sendMessage(
        chatId, 
        `You selected ${tradeState.buy ? "Long 🟢" : "Short 🔴"}. Enter the size in USDC:`
    );

    const sizeHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (sizeMsg) => {
            const size = sizeMsg.text;
            if (isNaN(size) || parseFloat(size) <= 0) {
                await bot.sendMessage(chatId, "Invalid size. Please enter a valid number.");
                return;
            }

            try {
                const userSession = await getUserSession(chatId);
                const check_balance = await CONTRACT_INSTANCE_USDC.balanceOf(userSession.address);
                const check_allowance = await CONTRACT_INSTANCE_USDC.allowance(
                    userSession.address, 
                    SPENDER_APPROVE
                );
                const requiredAmount = ethers.parseUnits(size.toString(), 6);
                
                tradeState.size = parseFloat(size);
                tradeState.stage = 'approval_check';
                await saveUserState(chatId, 'market_trade', tradeState);

                if (check_balance < requiredAmount) {
                    await bot.sendMessage(chatId, 
                        `Insufficient balance!\n` +
                        `Available Balance: ${ethers.formatUnits(check_balance, 6)} USDC\n` +
                        `Required Amount: ${size} USDC`
                    );
                    return;
                }

                if (check_allowance < requiredAmount) {
                    await handleInsufficientAllowance(
                        bot,
                        sizeMsg,
                        check_allowance,
                        size,
                        tradeState
                    );
                } else {
                    await handleLeverageInput(bot, chatId, size, tradeState.maxLeverage, tradeState);
                }

            } catch (error) {
                console.error("Trade processing error:", error);
                await bot.sendMessage(chatId, "Error processing trade. Please try again.");
            }
        }
    );

    bot.on('message', sizeHandler);
}

async function handleInsufficientAllowance(bot, sizeMsg, check_allowance, size, tradeState) {
    const chatId = sizeMsg.chat.id;
    const neededApproval = ethers.formatUnits(
        ethers.parseUnits(size.toString(), 6),
        6
    );
    
    const approveOptions = {
        reply_markup: JSON.stringify({
            inline_keyboard: [
                [{ text: "📝 Approve USDC", callback_data: `approve:${neededApproval}` }],
                [{ text: "❌ Cancel", callback_data: "approve:cancel" }],
            ],
        }),
    };

    await bot.sendMessage(chatId, 
        `⚠️ Insufficient Approval!\n\n` +
        `Current Allowance: ${ethers.formatUnits(check_allowance, 6)} USDC\n` +
        `Required Amount: ${size} USDC\n` +
        `Additional Needed: ${neededApproval} USDC`, 
        approveOptions
    );

    const approveHandler = createUserSpecificHandler(
        bot,
        chatId,
        'callback_query',
        async (approveCallback) => {
            const [action, value] = approveCallback.data.split(":");
            
            if (action === "approve" && value !== "cancel") {
                const approveMsg = {
                    chat: { id: chatId },
                    text: `/approve ${value}`
                };

                const approvalSuccess = await handleApprove(bot, approveMsg, tradeState);
                
                if (!approvalSuccess) {
                    await bot.sendMessage(chatId, "Approval failed or was rejected. Please try again /openmarket");
                    return;
                }

                await handleLeverageInput(bot, chatId, size, tradeState.maxLeverage, tradeState);
            } else {
                await bot.sendMessage(chatId, "Trade cancelled. Use /openmarket to start again.");
                await clearUserState(chatId);
                userMarketStates.delete(chatId);
            }
        }
    );

    bot.on('callback_query', approveHandler);
}

async function handleLeverageInput(bot, chatId, size, maxLeverage, tradeState) {
    await bot.sendMessage(chatId, 
        `Size: ${size} USDC. Now enter leverage:\nMax leverage for this pair is ${maxLeverage}x`
    );

    tradeState.stage = 'leverage_input';
    await saveUserState(chatId, 'market_trade', tradeState);

    const leverageHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (leverageMsg) => {
            const leverage = leverageMsg.text;
            
            if (isNaN(leverage) || parseFloat(leverage) <= 0 || parseFloat(leverage) > maxLeverage) {
                await bot.sendMessage(chatId, 
                    `Invalid leverage. Please enter a valid number between 1 and ${maxLeverage}x`
                );
                return;
            }

            tradeState.leverage = parseFloat(leverage);
            tradeState.stage = 'sl_tp_selection';
            await saveUserState(chatId, 'market_trade', tradeState);

            await handleSLTPSetup(bot, chatId, tradeState);
        }
    );

    bot.on('message', leverageHandler);
}

async function handleSLTPSetup(bot, chatId, tradeState) {
    const slTpOptions = {
        reply_markup: JSON.stringify({
            inline_keyboard: [
                [{ text: "Yes", callback_data: "set_sl_tp:yes" }],
                [{ text: "No", callback_data: "set_sl_tp:no" }],
            ],
        }),
    };

    await bot.sendMessage(chatId, "Would you like to set Stop Loss and Take Profit?", slTpOptions);

    const slTpHandler = createUserSpecificHandler(
        bot,
        chatId,
        'callback_query',
        async (slTpCallback) => {
            const [action, value] = slTpCallback.data.split(":");
            
            if (value === "yes") {
                tradeState.stage = 'stop_loss_input';
                await saveUserState(chatId, 'market_trade', tradeState);
                
                await bot.sendMessage(
                    chatId,
                    `Enter Stop Loss price (or 'skip' to skip):\n` +
                    `Set Stoploss ${tradeState.buy ? 'Below' : 'Above'} Market Price ${
                        tradeState.price > 1
                        ? parseFloat(tradeState.price).toFixed(2)
                        : parseFloat(tradeState.price).toFixed(4)
                    }$\n`
                );

                await handleStopLossInput(bot, chatId, tradeState);
            } else {
                tradeState.stopLoss = 0;
                tradeState.takeProfit = 0;
                tradeState.stage = 'execution';
                await saveUserState(chatId, 'market_trade', tradeState);
                
                await bot.sendMessage(chatId, "Please check your wallet for trade confirmation...");
                await txQueueMarket.addTransaction(chatId, async () => {
                    await proceedWithTrade(
                        bot,
                        chatId,
                        tradeState.selectedPair,
                        tradeState.size,
                        tradeState.leverage,
                        tradeState.price,
                        tradeState.buy,
                        0,
                        0
                    );
                });
            }
        }
    );

    bot.on('callback_query', slTpHandler);
}

async function handleStopLossInput(bot, chatId, tradeState) {
    const slHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (slMsg) => {
            if (slMsg.text.toLowerCase() === 'skip') {
                tradeState.stopLoss = 0;
            } else {
                const stopLoss = parseFloat(slMsg.text);
                if (isNaN(stopLoss) || stopLoss <= 0) {
                    await bot.sendMessage(chatId, "Invalid Stop Loss. Please try again /openmarket");
                    return;
                }
                tradeState.stopLoss = stopLoss;
            }

            tradeState.stage = 'take_profit_input';
            await saveUserState(chatId, 'market_trade', tradeState);

            await bot.sendMessage(
                chatId,
                `Enter Take Profit price (or 'skip' to skip):\n` +
                `Set Take Profit ${tradeState.buy ? 'Above' : 'Below'} Market Price ${
                    tradeState.price > 1
                    ? parseFloat(tradeState.price).toFixed(2)
                    : parseFloat(tradeState.price).toFixed(4)
                }$\n`
            );

            await handleTakeProfitInput(bot, chatId, tradeState);
        }
    );

    bot.on('message', slHandler);
}

async function handleTakeProfitInput(bot, chatId, tradeState) {
    const tpHandler = createUserSpecificHandler(
        bot,
        chatId,
        'message',
        async (tpMsg) => {
            if (tpMsg.text.toLowerCase() === 'skip') {
                tradeState.takeProfit = 0;
            } else {
                const takeProfit = parseFloat(tpMsg.text);
                if (isNaN(takeProfit) || takeProfit <= 0) {
                    await bot.sendMessage(chatId, "Invalid Take Profit. Please try again /openmarket");
                    return;
                }
                tradeState.takeProfit = takeProfit;
            }

            tradeState.stage = 'execution';
            await saveUserState(chatId, 'market_trade', tradeState);

            await bot.sendMessage(chatId, "Please check your wallet for trade confirmation...");
            await txQueue.addTransaction(chatId, async () => {
                await proceedWithTrade(
                    bot,
                    chatId,
                    tradeState.selectedPair,
                    tradeState.size,
                    tradeState.leverage,
                    tradeState.price,
                    tradeState.buy,
                    tradeState.stopLoss || 0,
                    tradeState.takeProfit || 0
                );
            });
        }
    );

    bot.on('message', tpHandler);
}

async function proceedWithTrade(bot, chatId, selectedPair, size, leverage, Price, buy, stopLoss, takeProfit) {
    try {
        const userSession = await getUserSession(chatId);
        if (!userSession) throw new Error("Session not found");

        // Calculate adjusted stop-loss
        const adjustedStopLoss = stopLoss 
            ? (calculateStopLoss(Price, stopLoss, leverage, buy)).toFixed(3)
            : "0";
        
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
        const slippageP = ethers.parseUnits("1", 10);
        const executionFee = 0;

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

        // Send transaction request with chatId
        const { result } = await makeWalletConnectRequest(
            `/request/${userSession.topic}`,
            "POST",
            {
                chainId: `eip155:${BASE_CHAIN_ID}`,
                request: {
                    method: "eth_sendTransaction",
                    params: [{
                        from: userSession.address,
                        to: CONTRACT_ADDRESS_TRADING,
                        data: data,
                        value: "0x0",
                    }],
                }
            },
            chatId
        );

        const initialMessage = await bot.sendMessage(
            chatId,
            `Market trade transaction submitted! Hash: ${result}\n` +
            `Waiting for blockchain confirmation...`
        );

        await monitorTradeConfirmation(bot, chatId, result, initialMessage.message_id);

    } catch (error) {
        console.error("Open trade error:", error.message);
        await bot.sendMessage(chatId, `Failed to open trade. Error: ${error.response?.data?.message || error.message}`);
        await clearUserState(chatId);
        userMarketStates.delete(chatId);
    }
}

// Modified monitoring function for trades
async function monitorTradeConfirmation(bot, chatId, txHash, messageId, type = 'market') {
    const startTime = Date.now();
    const maxWaitTime = 2 * 60 * 1000; // 2 minutes timeout

    const checkConfirmations = async () => {
        try {
            // Check if request is still valid
            if (!isValidRequest(txHash, chatId)) {
                await bot.editMessageText(
                    `Trade request expired or invalid. Please try again with /open${type}.`,
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );
                return;
            }

            const receipt = await Provider.getTransactionReceipt(txHash);
            
            if (receipt) {
                const currentBlock = await Provider.getBlockNumber();
                const confirmations = currentBlock - receipt.blockNumber;

                if (confirmations >= 3) {
                    // Store trade in database and update request status
                    await storeTrade(chatId, txHash, {
                        type: type,
                        status: 'pending',
                        timestamp: Date.now()
                    });

                    updateRequestStatus(txHash, 'confirmed');

                    await bot.editMessageText(
                        `${type.charAt(0).toUpperCase() + type.slice(1)} Order Confirmed! ✅\n` +
                        `Transaction Hash: ${txHash}\n` +
                        `Confirmations: ${confirmations}\n` +
                        `Check your trades using /opentrades.`,
                        {
                            chat_id: chatId,
                            message_id: messageId
                        }
                    );
                    
                    // Cleanup after confirmation
                    activeRequests.delete(txHash);
                    return;
                }
            }

            if (Date.now() - startTime < maxWaitTime) {
                setTimeout(() => checkConfirmations(), 5000);
            } else {
                updateRequestStatus(txHash, 'timeout');
                await bot.editMessageText(
                    `${type.charAt(0).toUpperCase() + type.slice(1)} Order transaction timed out.\n` +
                    `Please check /opentrades to verify status.\n` +
                    `Transaction Hash: ${txHash}`,
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );
            }
        } catch (error) {
            console.error("Trade confirmation check error:", error);
            updateRequestStatus(txHash, 'error');
            await bot.editMessageText(
                `Error checking ${type} order status.\n` +
                `Please check /opentrades to verify status.\n` +
                `Transaction Hash: ${txHash}`,
                {
                    chat_id: chatId,
                    message_id: messageId
                }
            );
        }
    };

    await checkConfirmations();
}



async function startPriceMonitoring(chatId, tradeData) {
    // Stop existing monitor if any
    stopPriceMonitoring(chatId);

    const monitor = {
        interval: setInterval(async () => {
            try {
                const currentPrice = await price({ 
                    id: [feedIds[tradeData.pairName.toUpperCase()].id] 
                });

                // Check for SL/TP hits
                if (tradeData.sl && shouldTriggerStopLoss(currentPrice, tradeData)) {
                    await handleStopLossHit(chatId, tradeData);
                }

                if (tradeData.tp && shouldTriggerTakeProfit(currentPrice, tradeData)) {
                    await handleTakeProfitHit(chatId, tradeData);
                }

                // Update stored price
                await updateStoredPrice(chatId, tradeData.index, currentPrice);

            } catch (error) {
                console.error('Price monitoring error:', error);
            }
        }, 30000), // Check every 30 seconds
        data: tradeData
    };

    priceMonitors.set(chatId, monitor);
}

function stopPriceMonitoring(chatId) {
    const monitor = priceMonitors.get(chatId);
    if (monitor) {
        clearInterval(monitor.interval);
        priceMonitors.delete(chatId);
    }
}

async function handleStopLossHit(chatId, tradeData) {
    try {
        // Notify user
        await bot.sendMessage(chatId,
            `⚠️ Stop Loss Alert!\n` +
            `${tradeData.pairName} position approaching stop loss level.\n` +
            `Consider managing your position.`
        );

        // Update trade status
        await updateTradeStatus(chatId, tradeData.index, 'sl_warning');

    } catch (error) {
        console.error('Stop loss handling error:', error);
    }
}

async function handleTakeProfitHit(chatId, tradeData) {
    try {
        // Notify user
        await bot.sendMessage(chatId,
            `🎯 Take Profit Alert!\n` +
            `${tradeData.pairName} position reaching take profit target.\n` +
            `Consider securing profits.`
        );

        // Update trade status
        await updateTradeStatus(chatId, tradeData.index, 'tp_warning');

    } catch (error) {
        console.error('Take profit handling error:', error);
    }
}

// Update stored price in database
async function updateStoredPrice(chatId, tradeIndex, currentPrice) {
    return new Promise((resolve, reject) => {
        db.run(`
            UPDATE trades 
            SET trade_data = json_set(trade_data, '$.currentPrice', ?)
            WHERE chat_id = ? AND json_extract(trade_data, '$.index') = ?
        `, [currentPrice, chatId, tradeIndex], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Helper functions for SL/TP checks
function shouldTriggerStopLoss(currentPrice, tradeData) {
    const price = parseFloat(currentPrice);
    const sl = parseFloat(tradeData.sl);
    
    if (tradeData.buy) {
        return price <= sl;
    } else {
        return price >= sl;
    }
}

function shouldTriggerTakeProfit(currentPrice, tradeData) {
    const price = parseFloat(currentPrice);
    const tp = parseFloat(tradeData.tp);
    
    if (tradeData.buy) {
        return price >= tp;
    } else {
        return price <= tp;
    }
}

// Enhanced price function with retry
async function price(params) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const connection = new PriceServiceConnection("https://hermes.pyth.network");
            const currentPrices = await connection.getLatestPriceFeeds(params?.id);
            return String((currentPrices[0].price.price)/10**8);
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
    }

    throw lastError;
}

async function handleGetTrades(bot, msg) {
    const chatId = msg?.chat?.id;
    try {
        await bot.sendMessage(chatId, "**Fetching Open trades 🔃**");

        const userSession = await getUserSession(chatId);
        if (!userSession || !userSession.address) {
            await bot.sendMessage(chatId, 
                "Please connect your wallet first using /connect , Make sure wallet supports Base chain"
            );
            return;
        }

        // Store view state
        await saveUserState(chatId, 'view_trades', {
            timestamp: Date.now()
        });

        // Fetch trades and pending orders
        const { trades, pendingOpenLimitOrders } = await getTrades(
            userSession.address, 
            CONTRACT_INSTANCE_MULTICALL
        );

        if (trades.length === 0 && pendingOpenLimitOrders.length === 0) {
            await bot.sendMessage(chatId, "You have no open trades or pending orders.");
            await clearUserState(chatId);
            return;
        }

        // Display open trades
        if (trades.length > 0) {
            for (const trade of trades) {
                try {
                    const pairName = pairs_with_index_number[parseInt(trade.pairIndex.toString())] || "Unknown Pair";
                    const openPrice = ethers.formatUnits(trade.openPrice, 10);
                    const currentPrices = await price({ id: [feedIds[pairName.toUpperCase()].id] });
                    
                    const profitStatus = trade.buy
                        ? (openPrice < currentPrices ? "Profit 🤑" : "Loss 😞")
                        : (openPrice > currentPrices ? "Profit 🤑" : "Loss 😞");

                    // Format trade message
                    const tradeMessage = formatTradeMessage(
                        trade,
                        pairName,
                        openPrice,
                        currentPrices,
                        profitStatus
                    );

                    // Send message with inline keyboard
                    await sendTradeMessage(
                        bot,
                        chatId,
                        tradeMessage,
                        trade,
                        'active'
                    );

                    // Store trade in database if not exists
                    await upsertTradeInDatabase(chatId, trade);

                } catch (error) {
                    console.error(`Error processing trade ${trade.index}:`, error);
                }
            }
        }

        // Display pending limit orders
        if (pendingOpenLimitOrders.length > 0) {
            for (const order of pendingOpenLimitOrders) {
                try {
                    const pairName = pairs_with_index_number[parseInt(order.pairIndex.toString())] || "Unknown Pair";
                    const orderMessage = formatLimitOrderMessage(order, pairName);

                    // Send message with inline keyboard
                    await sendTradeMessage(
                        bot,
                        chatId,
                        orderMessage,
                        order,
                        'pending'
                    );

                    // Store order in database if not exists
                    await upsertTradeInDatabase(chatId, order, true);

                } catch (error) {
                    console.error(`Error processing order ${order.index}:`, error);
                }
            }
        }

        await clearUserState(chatId);

    } catch (error) {
        console.error("Error fetching trades:", error);
        await bot.sendMessage(chatId, "Failed to fetch trades. Please try again later.");
        await clearUserState(chatId);
    }
}

// Format trade message
function formatTradeMessage(trade, pairName, openPrice, currentPrice, profitStatus) {
    return `
    🚀 TRADE INSIGHTS 📊

    ${trade.buy ? "🟢 LONG" : "🔴 SHORT"} | ${pairName.toUpperCase()}

    ✨ Position State 
    ────────────────────
    ${profitStatus}
    
    (Profit/Loss API Integration Soon)

    💰 Position Details
    ────────────────────
    📍 Position Size: ${parseFloat(ethers.formatUnits(trade.initialPosToken, 6)).toFixed(2)} USDC
    ⚡ Leverage: ${ethers.formatUnits(trade.leverage, 10)}x
    💰 Volume: ${parseFloat(ethers.formatUnits(trade.initialPosToken, 6) * ethers.formatUnits(trade.leverage, 10))}

    🎯 Trade Markers
    ────────────────────
    🔹 Open Price: ${openPrice > 1 ? parseFloat(openPrice).toFixed(2) : parseFloat(openPrice).toFixed(4)}$
    💹 Current Price: ${currentPrice > 1 ? parseFloat(currentPrice).toFixed(2) : parseFloat(currentPrice).toFixed(4)}$
     
    🚦 Take Profit: ${trade?.tp > 1 ? parseFloat(ethers.formatUnits(trade.tp, 10)).toFixed(2) : parseFloat(ethers.formatUnits(trade.tp, 10)).toFixed(4)}$
    ⚠️ Stop Loss: ${trade?.sl > 1 ? parseFloat(ethers.formatUnits(trade.sl, 10)).toFixed(2) : parseFloat(ethers.formatUnits(trade.sl, 10)).toFixed(4)}$
    💥 Liquidation: ${trade?.liquidationPrice > 1 ? parseFloat(ethers.formatUnits(trade.liquidationPrice, 10)).toFixed(2) : parseFloat(ethers.formatUnits(trade.liquidationPrice, 10)).toFixed(4)}$

    ${trade.buy ? "🚀 Riding the Bullish Wave" : "🐻 Navigating Bearish Currents"}

    💡 Smart Trading Tip:
    Risk wisely, trade confidently! 
    Your strategic move starts here. 🌟
    `;
}

// Format limit order message
function formatLimitOrderMessage(order, pairName) {
    return `
    **Pending Limit Order:**
    - Pair: ${pairName}
    - Position Size: ${ethers.formatUnits(order.positionSize, 6)}
    - Leverage: ${ethers.formatUnits(order.leverage, 10)}x
    - Price: ${ethers.formatUnits(order.price, 10)}
    - Take Profit: ${ethers.formatUnits(order.tp, 10)}
    - Stop Loss: ${ethers.formatUnits(order.sl, 10)}
    `;
}

// Send trade message with appropriate keyboard
async function sendTradeMessage(bot, chatId, message, trade, type) {
    const keyboard = type === 'active' 
        ? [
            [
                {
                    text: "Close ❌",
                    callback_data: `close_trade:${trade.pairIndex}:${trade.index}:${ethers.formatUnits(trade.initialPosToken, 6)}`,
                },
                {
                    text: "Close Partial 📉",
                    callback_data: `close_partial:${trade.pairIndex}:${trade.index}:${ethers.formatUnits(trade.initialPosToken, 6)}`,
                },
            ]
        ]
        : [
            [
                {
                    text: "Close ❌",
                    callback_data: `close_limit_trade:${trade.pairIndex}:${trade.index}`,
                }
            ]
        ];

    await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

// Upsert trade in database
async function upsertTradeInDatabase(chatId, trade, isLimit = false) {
    const tradeData = {
        pairIndex: trade.pairIndex.toString(),
        index: trade.index.toString(),
        size: isLimit 
            ? ethers.formatUnits(trade.positionSize, 6)
            : ethers.formatUnits(trade.initialPosToken, 6),
        type: isLimit ? 'limit' : 'market',
        status: isLimit ? 'pending' : 'active',
        timestamp: Date.now()
    };

    console.log(tradeData)

    return new Promise((resolve, reject) => {
        db.run(`
            INSERT OR REPLACE INTO trades (
                chat_id,
                order_id,
                timestamp,
                trade_status,
                trade_type,
                trade_data
            ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
            chatId,
            `${tradeData.type}_${tradeData.index}`,
            tradeData.timestamp,
            tradeData.status,
            tradeData.type,
            JSON.stringify(tradeData)
        ], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Handle trade close callback for market positions
async function handleTradeCloseCallback(bot, query, contractInstance, size) {
    const chatId = query.message.chat.id;

    try {
        // Get user session and validate
        const userSession = await getUserSession(chatId);
        if (!userSession || !userSession.address) {
            await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
            return;
        }

        // Store close state
        await saveUserState(chatId, 'close_trade', {
            type: 'market',
            timestamp: Date.now()
        });

        const callbackData = query.data.split(":");
        const pairIndex = parseInt(callbackData[1], 10);
        const tradeIndex = parseInt(callbackData[2], 10);
        const tradeSize = !size ? parseFloat(callbackData[3]) : size;

        // Prepare trade parameters
        const tradeParams = {
            pairIndex: pairIndex,
            index: tradeIndex,
            amount: ethers.parseUnits(tradeSize.toString(), 6),
            executionFee: 0
        };

        // Encode function call
        const iface = new ethers.Interface(TRADING_ABI);
        const data = iface.encodeFunctionData('closeTradeMarket', [
            tradeParams.pairIndex,
            tradeParams.index,
            tradeParams.amount,
            tradeParams.executionFee,
        ]);

        await bot.sendMessage(chatId, 'Check your wallet for approval...');

        // Calculate execution fee
        const valueInWei = ethers.parseUnits("0.000006", "ether").toString(16);
        const valueHex = `0x${valueInWei}`;

        // Send close request
        const { result } = await makeWalletConnectRequest(
            `/request/${userSession.topic}`,
            'POST',
            {
                chainId: `eip155:${BASE_CHAIN_ID}`,
                request: {
                    method: 'eth_sendTransaction',
                    params: [{
                        from: userSession.address,
                        to: CONTRACT_ADDRESS_TRADING,
                        data: data,
                        value: valueHex,
                    }],
                }
            },
            chatId
        );

        const initialMessage = await bot.sendMessage(
            chatId,
            `Market Close transaction submitted! Hash: ${result}\n` +
            `Waiting for blockchain confirmation...`
        );

        await monitorCloseConfirmation(
            bot,
            chatId,
            result,
            initialMessage.message_id,
            'market'
        );

    } catch (error) {
        console.error("Close trade error:", error);
        await bot.answerCallbackQuery(query.id, { 
            text: "Failed to close trade. Try again later.",
            show_alert: true
        });
        await clearUserState(chatId);
    }
}

// Handle trade close callback for limit orders
async function handleTradeCloseCallback_limit(bot, query, contractInstance) {
    const chatId = query.message.chat.id;

    try {
        const userSession = await getUserSession(chatId);
        if (!userSession || !userSession.address) {
            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, "Please connect your wallet first using /connect");
            return;
        }

        // Store close state
        await saveUserState(chatId, 'close_trade', {
            type: 'limit',
            timestamp: Date.now()
        });

        const callbackData = query.data.split(":");
        const pairIndex = parseInt(callbackData[1], 10);
        const tradeIndex = parseInt(callbackData[2], 10);

        // Encode function call
        const iface = new ethers.Interface(TRADING_ABI);
        const data = iface.encodeFunctionData('cancelOpenLimitOrder', [
            pairIndex,
            tradeIndex,
        ]);

        const walletMsg = await bot.sendMessage(chatId, 'Check your wallet for approval...');

        // Send cancel request
        const { result } = await makeWalletConnectRequest(
            `/request/${userSession.topic}`,
            'POST',
            {
                chainId: `eip155:${BASE_CHAIN_ID}`,
                request: {
                    method: 'eth_sendTransaction',
                    params: [{
                        from: userSession.address,
                        to: CONTRACT_ADDRESS_TRADING,
                        data: data,
                        value: "0x0",
                    }],
                }
            },
            chatId
        );

        // Clean up wallet message
        await bot.deleteMessage(chatId, walletMsg.message_id);

        const initialMessage = await bot.sendMessage(
            chatId,
            `Cancel Limit Order submitted! Hash: ${result}\n` +
            `Pair Index: ${pairIndex}, Trade Index: ${tradeIndex}\n` +
            `Waiting for blockchain confirmation...`
        );

        await bot.answerCallbackQuery(query.id);
        await monitorCloseConfirmation(
            bot,
            chatId,
            result,
            initialMessage.message_id,
            'limit'
        );

    } catch (error) {
        console.error("Handle limit trade cancellation error:", error);
        try {
            await bot.answerCallbackQuery(query.id, { 
                text: "Failed to cancel limit order. Please try again later.",
                show_alert: true 
            });
        } catch (cbError) {
            console.error("Error answering callback query:", cbError);
        }
        await bot.sendMessage(chatId, "❌ Failed to cancel limit order. Please try again later.");
        await clearUserState(chatId);
    }
}

// Monitor trade close confirmation
async function monitorCloseConfirmation(bot, chatId, txHash, messageId, closeType) {
    const startTime = Date.now();
    const maxWaitTime = 2 * 60 * 1000; // 2 minutes timeout

    const checkConfirmations = async () => {
        try {
            const receipt = await Provider.getTransactionReceipt(txHash);
            
            if (receipt) {
                const currentBlock = await Provider.getBlockNumber();
                const confirmations = currentBlock - receipt.blockNumber;

                if (confirmations >= 3) {
                    // Update trade status in database
                    await updateTradeStatus(chatId, txHash, 'closed');

                    const successMessage = closeType === 'market'
                        ? `Position Closed Successfully! ✅\n`
                        : `Cancel Limit Order Successful! ✅\n`;

                    await bot.editMessageText(
                        `${successMessage}` +
                        `Transaction Hash: ${txHash}\n` +
                        `Confirmations: ${confirmations}\n` +
                        `Check your trades using /opentrades.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: 'HTML'
                        }
                    );

                    await clearUserState(chatId);
                    return;
                }
            }

            if (Date.now() - startTime < maxWaitTime) { 
                setTimeout(() => checkConfirmations(), 5000);
            } else {
                await bot.editMessageText(
                    `Close transaction timed out. Please check /opentrades to verify status.\n` +
                    `Transaction Hash: ${txHash}`,
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );
            }
        } catch (error) {
            console.error("Close confirmation check error:", error);
            if (messageId) {
                await bot.editMessageText(
                    `Error checking close status. Please check /opentrades to verify status.\n` +
                    `Transaction Hash: ${txHash}`,
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );
            }
        }
    };

    await checkConfirmations();
}

// Update trade status in database
async function updateTradeStatus(chatId, txHash, status) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE trades 
             SET trade_status = ?, 
                 last_update = CURRENT_TIMESTAMP 
             WHERE chat_id = ? AND tx_hash = ?`,
            [status, chatId, txHash],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}


// Function to handle viewing historical trades
async function handleViewTrades(bot, msg) {
    const chatId = msg.chat.id;
    try {
        // Get recent trades from database
        const trades = await getRecentTrades(chatId);

        if (trades.length === 0) {
            await bot.sendMessage(chatId, 'No trades found.');
            return;
        }

        // Format and send trade history
        const tradesMessage = trades.map(trade => 
            `Order ID: ${trade.order_id}\n` +
            `Transaction: ${trade.tx_hash}\n` +
            `Time: ${new Date(trade.timestamp * 1000).toLocaleString()}\n` +
            `Status: ${trade.trade_status}\n`
        ).join('\n');

        await bot.sendMessage(chatId, `Your recent trades:\n\n${tradesMessage}`);

    } catch (error) {
        console.error('View trades error:', error);
        await bot.sendMessage(chatId, 'Failed to fetch trades. Please try again.');
    }
}

// Get recent trades from database
async function getRecentTrades(chatId, limit = 5) {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT * FROM trades 
            WHERE chat_id = ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `, [chatId, limit], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getUserSession(chatId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM user_sessions WHERE chat_id = ?`,
            [chatId],
            (err, row) => {
                if (err) {
                    console.error('Error getting user session:', err);
                    reject(err);
                } else {
                    if (row && row.session_data) {
                        try {
                            row.session = JSON.parse(row.session_data);
                        } catch (e) {
                            console.error('Error parsing session data:', e);
                        }
                    }
                    resolve(row);
                }
            }
        );
    });
}
async function saveUserSession(chatId, topic, address, sessionData) {
    return new Promise((resolve, reject) => {
        db.run(`
            INSERT OR REPLACE INTO user_sessions 
            (chat_id, topic, address, session_data, last_activity, connection_status) 
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'connected')
        `, [chatId, topic, address, sessionData], function(err) {
            if (err) {
                console.error('Error saving session:', err);
                reject(err);
            } else {
                console.log('Session saved successfully:', {
                    chatId,
                    topic,
                    address,
                    lastID: this.lastID
                });
                resolve(this.lastID);
            }
        });
    });
}
 
// New function to track user state during trade flows
async function saveUserState(chatId, tradeFlow, tradeData) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        db.run(
            `INSERT OR REPLACE INTO user_states 
             (chat_id, current_trade_flow, trade_data, last_update) 
             VALUES (?, ?, ?, ?)`,
            [chatId, tradeFlow, JSON.stringify(tradeData), now],
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

// Session cleanup function
async function cleanupInactiveSessions(maxAge = 24 * 60 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const cutoff = new Date(Date.now() - maxAge).toISOString();
        db.run(
            `DELETE FROM user_sessions 
             WHERE last_activity < ? 
             AND connection_status = 'disconnected'`,
            [cutoff],
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



// Initialize error recovery system

// Add error logging table
async function initErrorLogging() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Error logs table
            db.run(`
                CREATE TABLE IF NOT EXISTS error_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER,
                    error_message TEXT,
                    error_context TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) reject(err);
            });

            // Recovery logs table
            db.run(`
                CREATE TABLE IF NOT EXISTS recovery_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER,
                    recovery_status TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });
}
// Global error recovery and monitoring system
class ErrorRecovery {
    constructor() {
        this.errorCounts = new Map();
        this.recoveryAttempts = new Map();
        this.MAX_ERRORS = 5;
        this.RECOVERY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    }

    async handleError(chatId, error, context) {
        console.error(`Error in ${context}:`, error);

        // Update error count
        const currentCount = this.errorCounts.get(chatId) || 0;
        this.errorCounts.set(chatId, currentCount + 1);

        // Check if recovery is needed
        if (currentCount + 1 >= this.MAX_ERRORS) {
            await this.initiateRecovery(chatId);
        }

        // Log error to database
        await this.logError(chatId, error, context);
    }

    async initiateRecovery(chatId) {
        // Check if recovery is already in progress
        if (this.recoveryAttempts.get(chatId)) {
            return;
        }

        this.recoveryAttempts.set(chatId, true);

        try {
            // Clear user state
            await clearUserState(chatId);

            // Reset session if needed
            const userSession = await getUserSession(chatId);
            if (userSession) {
                await this.reconnectUserSession(chatId, userSession);
            }

            // Clear error count
            this.errorCounts.delete(chatId);

            // Log recovery attempt
            await this.logRecovery(chatId, 'success');

        } catch (error) {
            console.error('Recovery failed:', error);
            await this.logRecovery(chatId, 'failed');
        } finally {
            // Clear recovery flag after timeout
            setTimeout(() => {
                this.recoveryAttempts.delete(chatId);
            }, this.RECOVERY_TIMEOUT);
        }
    }

    async reconnectUserSession(chatId, userSession) {
        try {
            // Attempt to verify existing session
            await makeWalletConnectRequest(
                `/session/${userSession.topic}`,
                'GET',
                null,
                chatId
            );
        } catch (error) {
            // Session invalid, update database
            await db.run(
                `UPDATE user_sessions 
                 SET connection_status = 'disconnected' 
                 WHERE chat_id = ?`,
                [chatId]
            );

            // Notify user
            await bot.sendMessage(
                chatId,
                'Your session was disconnected due to errors. Please reconnect using /connect'
            );
        }
    }

    async logError(chatId, error, context) {
        return new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO error_logs (
                    chat_id,
                    error_message,
                    error_context,
                    timestamp
                ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                chatId,
                error.message || String(error),
                context
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async logRecovery(chatId, status) {
        return new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO recovery_logs (
                    chat_id,
                    recovery_status,
                    timestamp
                ) VALUES (?, ?, CURRENT_TIMESTAMP)
            `, [
                chatId,
                status
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

const errorRecovery = new ErrorRecovery();

// Transaction monitoring system
class TransactionMonitor {
    constructor() {
        this.pendingTransactions = new Map();
        this.TRANSACTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    }

    async trackTransaction(chatId, txHash, type) {
        this.pendingTransactions.set(txHash, {
            chatId,
            type,
            startTime: Date.now()
        });

        // Set timeout for transaction
        setTimeout(() => this.checkTransaction(txHash), this.TRANSACTION_TIMEOUT);
    }

    async checkTransaction(txHash) {
        const txInfo = this.pendingTransactions.get(txHash);
        if (!txInfo) return;

        try {
            const receipt = await Provider.getTransactionReceipt(txHash);
            
            if (!receipt) {
                // Transaction still pending after timeout
                await this.handleStuckTransaction(txInfo.chatId, txHash, txInfo.type);
            }

        } catch (error) {
            console.error('Transaction check error:', error);
            await errorRecovery.handleError(
                txInfo.chatId,
                error,
                'transaction_monitor'
            );
        } finally {
            this.pendingTransactions.delete(txHash);
        }
    }

    async handleStuckTransaction(chatId, txHash, type) {
        try {
            // Notify user
            await bot.sendMessage(
                chatId,
                `⚠️ Transaction taking longer than expected.\n` +
                `Type: ${type}\n` +
                `Hash: ${txHash}\n` +
                `Please check your wallet or try again.`
            );

            // Log incident
            await db.run(`
                INSERT INTO transaction_logs (
                    chat_id,
                    tx_hash,
                    tx_type,
                    status,
                    timestamp
                ) VALUES (?, ?, ?, 'stuck', CURRENT_TIMESTAMP)
            `, [chatId, txHash, type]);

        } catch (error) {
            console.error('Stuck transaction handling error:', error);
        }
    }
}

const transactionMonitor = new TransactionMonitor();

// Add transaction logging table
async function initTransactionLogging() {
    return new Promise((resolve, reject) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS transaction_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER,
                tx_hash TEXT,
                tx_type TEXT,
                status TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// System health monitor
class SystemHealthMonitor {
    constructor() {
        this.healthChecks = new Map();
        this.CHECK_INTERVAL = 60 * 1000; // 1 minute
    }

    startMonitoring() {
        setInterval(() => this.runHealthChecks(), this.CHECK_INTERVAL);
    }

    async runHealthChecks() {
        try {
            // Check database connection
            await this.checkDatabase();

            // Check WalletConnect service
            await this.checkWalletConnect();

            // Check price service
            await this.checkPriceService();

            // Monitor system resources
            await this.checkSystemResources();

        } catch (error) {
            console.error('Health check error:', error);
        }
    }

    async checkDatabase() {
        try {
            await new Promise((resolve, reject) => {
                db.get('SELECT 1', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            this.updateHealth('database', 'healthy');
        } catch (error) {
            this.updateHealth('database', 'unhealthy');
            throw error;
        }
    }

    async checkWalletConnect() {
        try {
            // await makeWalletConnectRequest('/health', 'GET');
            this.updateHealth('wallet_connect', 'healthy');
        } catch (error) {
            this.updateHealth('wallet_connect', 'unhealthy');
            throw error;
        }
    }

    async checkPriceService() {
        try {
            const connection = new PriceServiceConnection("https://hermes.pyth.network");
            await connection.getLatestPriceFeeds([]);
            this.updateHealth('price_service', 'healthy');
        } catch (error) {
            this.updateHealth('price_service', 'unhealthy');
            throw error;
        }
    }

    async checkSystemResources() {
        // Monitor memory usage
        const memoryUsage = process.memoryUsage();
        if (memoryUsage.heapUsed / memoryUsage.heapTotal > 0.9) {
            console.warn('High memory usage detected');
        }

        // Log system status
        await this.logSystemStatus({
            memoryUsage,
            uptime: process.uptime(),
            timestamp: Date.now()
        });
    }

    updateHealth(service, status) {
        this.healthChecks.set(service, {
            status,
            lastCheck: Date.now()
        });
    }

    async logSystemStatus(status) {
        return new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO system_logs (
                    memory_usage,
                    uptime,
                    timestamp
                ) VALUES (?, ?, CURRENT_TIMESTAMP)
            `, [
                JSON.stringify(status.memoryUsage),
                status.uptime
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

const systemMonitor = new SystemHealthMonitor();

// Add system logging table
async function initSystemLogging() {
    return new Promise((resolve, reject) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_usage TEXT,
                uptime REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}


// Enhanced startup with monitoring and recovery
async function startServer() {
    try {
        // Initialize all logging tables
        await initDatabase();
        await initErrorLogging();
        await initTransactionLogging();
        await initSystemLogging();

        // Start system monitoring
       

        // Initialize bot with error handling
        const bot = await initBot();

        // Set up global error handlers
        setupGlobalErrorHandlers(bot);

        // Start monitoring system health
        const intervals =  systemMonitor.startMonitoring();

        // Setup graceful shutdown
        // setupGracefulShutdown(bot, intervals);

        return bot;
    } catch (error) {
        console.error('Server startup error:', error);
        throw error;
    }
}

function setupGlobalErrorHandlers(bot) {
    // Handle unhandled promise rejections
    process.on('unhandledRejection', async (reason, promise) => {
        console.error('Unhandled Rejection:', reason);
        
        // Try to extract chatId from promise context
        let chatId;
        try {
            const promiseDetails = await promise;
            chatId = promiseDetails?.chat?.id;
        } catch (e) {
            // Ignore extraction errors
        }

        if (chatId) {
            await errorRecovery.handleError(
                chatId,
                reason,
                'unhandled_rejection'
            );
        }
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
        console.error('Uncaught Exception:', error);
        
        // Log global error
        await errorRecovery.logError(
            0, // Use 0 for system-wide errors
            error,
            'uncaught_exception'
        );

        // Attempt graceful recovery
        try {
            await restartBot(bot);
        } catch (e) {
            console.error('Failed to restart bot:', e);
            process.exit(1);
        }
    });

    // Handle SIGTERM
    process.on('SIGTERM', async () => {
        console.log('SIGTERM received. Starting graceful shutdown...');
        await performGracefulShutdown(bot);
        process.exit(0);
    });
}

async function restartBot(bot) {
    try {
        // Stop polling
        await bot.stopPolling();

        // Wait for current operations to complete
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Restart polling
        await bot.startPolling();

        console.log('Bot successfully restarted');
    } catch (error) {
        console.error('Bot restart failed:', error);
        throw error;
    }
}

async function performGracefulShutdown(bot) {
    try {
        // Stop all monitoring
        clearAllIntervals();

        // Disconnect all active sessions
        await disconnectAllSessions();

        // Close database connections
        await closeDatabase();

        console.log('Graceful shutdown completed');
    } catch (error) {
        console.error('Error during shutdown:', error);
        throw error;
    }
}

// Maintenance and cleanup system
class MaintenanceSystem {
    constructor() {
        this.CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
        this.MAX_LOG_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
        this.MAX_INACTIVE_SESSION_AGE = 24 * 60 * 60 * 1000; // 24 hours
    }

    startMaintenance() {
        setInterval(() => this.performMaintenance(), this.CLEANUP_INTERVAL);
    }

    async performMaintenance() {
        try {
            await this.cleanupOldLogs();
            await this.cleanupInactiveSessions();
            await this.cleanupStaleTransactions();
            await this.optimizeDatabase();
        } catch (error) {
            console.error('Maintenance error:', error);
        }
    }

    async cleanupOldLogs() {
        const cutoffTime = Date.now() - this.MAX_LOG_AGE;
        
        const queries = [
            'DELETE FROM error_logs WHERE timestamp < ?',
            'DELETE FROM recovery_logs WHERE timestamp < ?',
            'DELETE FROM transaction_logs WHERE timestamp < ?',
            'DELETE FROM system_logs WHERE timestamp < ?'
        ];

        for (const query of queries) {
            await new Promise((resolve, reject) => {
                db.run(query, [new Date(cutoffTime).toISOString()], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    }

    async cleanupInactiveSessions() {
        const cutoffTime = Date.now() - this.MAX_INACTIVE_SESSION_AGE;
        
        await new Promise((resolve, reject) => {
            db.run(`
                DELETE FROM user_sessions 
                WHERE last_activity < ? 
                AND connection_status = 'disconnected'`,
                [new Date(cutoffTime).toISOString()],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    async cleanupStaleTransactions() {
        const cutoffTime = Date.now() - (30 * 60 * 1000); // 30 minutes
        
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE trades 
                SET trade_status = 'failed' 
                WHERE timestamp < ? 
                AND trade_status = 'pending'`,
                [new Date(cutoffTime).toISOString()],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    async optimizeDatabase() {
        await new Promise((resolve, reject) => {
            db.run('VACUUM', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async getMaintenanceStats() {
        return new Promise((resolve, reject) => {
            db.get(`
                SELECT 
                    (SELECT COUNT(*) FROM error_logs) as error_count,
                    (SELECT COUNT(*) FROM user_sessions WHERE connection_status = 'connected') as active_sessions,
                    (SELECT COUNT(*) FROM trades WHERE trade_status = 'pending') as pending_trades,
                    (SELECT COUNT(*) FROM trades WHERE trade_status = 'failed') as failed_trades
            `, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }
}

const maintenanceSystem = new MaintenanceSystem();


// Add maintenance stats to system monitoring
async function logMaintenanceStats() {
    try {
        const stats = await maintenanceSystem.getMaintenanceStats();
        await db.run(`
            INSERT INTO maintenance_logs (
                error_count,
                active_sessions,
                pending_trades,
                failed_trades,
                timestamp
            ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
            stats.error_count,
            stats.active_sessions,
            stats.pending_trades,
            stats.failed_trades
        ]);
    } catch (error) {
        console.error('Error logging maintenance stats:', error);
    }
}

// Initialize maintenance logging table
async function initMaintenanceLogging() {
    return new Promise((resolve, reject) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS maintenance_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                error_count INTEGER,
                active_sessions INTEGER,
                pending_trades INTEGER,
                failed_trades INTEGER,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Function to get system status
async function getSystemStatus() {
    try {
        const stats = await maintenanceSystem.getMaintenanceStats();
        const memoryUsage = process.memoryUsage();
        
        return {
            status: 'operational',
            uptime: process.uptime(),
            memory: {
                used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                total: Math.round(memoryUsage.heapTotal / 1024 / 1024)
            },
            stats: {
                errors: stats.error_count,
                activeSessions: stats.active_sessions,
                pendingTrades: stats.pending_trades,
                failedTrades: stats.failed_trades
            },
            lastMaintenance: await getLastMaintenanceTime()
        };
    } catch (error) {
        console.error('Error getting system status:', error);
        return {
            status: 'error',
            error: error.message
        };
    }
}

async function getLastMaintenanceTime() {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT timestamp FROM maintenance_logs ORDER BY timestamp DESC LIMIT 1',
            (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.timestamp : null);
            }
        );
    });
}

// Start the server with retry logic
(async () => {
    let retryCount = 0;
    const MAX_RETRIES = 5;

    while (retryCount < MAX_RETRIES) {
        try {
            await startServer();
            console.log('Server started successfully');
            break;
        } catch (error) {
            retryCount++;
            console.error(
                `Server start failed (Attempt ${retryCount}/${MAX_RETRIES}):`,
                error
            );

            if (retryCount === MAX_RETRIES) {
                console.error('Max retries exceeded. Exiting...');
                process.exit(1);
            }

            // Exponential backoff
            const delay = Math.pow(2, retryCount) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
})();
