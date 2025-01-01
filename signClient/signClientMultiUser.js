// signClient.js
const { SignClient } = require('@walletconnect/sign-client');
const express = require('express');
const cors = require('cors');
const globalSessionManager = require('./globalSessionstorageMultiUser');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const app = express();

// Enhanced logging
function log(level, message, error = null) {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] ${message}`, error ? error : '');
}

// Retry mechanism with exponential backoff
async function retryOperation(operation, maxRetries = 5, baseDelay = 1000) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            const delay = baseDelay * Math.pow(2, attempt);
            log('warn', `Operation failed (Attempt ${attempt + 1}/${maxRetries}). Retrying in ${delay}ms`, error);
            
            const jitteredDelay = delay * (0.7 + Math.random() * 0.6);
            await new Promise(resolve => setTimeout(resolve, jitteredDelay));
        }
    }
    throw new Error('Max retries exceeded');
}

class UserSignClient {
    constructor(chatId) {
        this.chatId = chatId;
        this.signClient = null;
    }

    async init() {
        return retryOperation(async () => {
            try {
                this.signClient = await SignClient.init({
                    projectId: process.env.PROJECT_ID,
                    metadata: {
                        name: 'Avantis Trading Bot',
                        description: 'Avantis Levearage Platform Trading Bot On Base Chain',
                        url: 'https://walletconnect.com',
                        icons: ['https://avatars.githubusercontent.com/u/37784886']
                    }
                });
                this.setupEventListeners();
                log('info', `SignClient initialized for user ${this.chatId}`);
                return this.signClient;
            } catch (error) {
                log('error', `SignClient initialization failed for user ${this.chatId}`, error);
                throw error;
            }
        });
    }

    setupEventListeners() {
        ['session_event', 'session_update', 'session_delete', 'session_expire'].forEach(eventName => {
            this.signClient.on(eventName, async (data) => {
                try {
                    const topic = data.topic;
                    switch(eventName) {
                        case 'session_event':
                            log('info', `Session Event for user ${this.chatId}: ${JSON.stringify(data.event)}`);
                            globalSessionManager.updateSessionStatus(topic, 'updated');
                            break;
                        case 'session_update':
                            log('info', `Session Update for user ${this.chatId}: ${topic}`);
                            globalSessionManager.updateSessionStatus(topic, 'updated');
                            break;
                        case 'session_delete':
                        case 'session_expire':
                            log('warn', `Session Terminated for user ${this.chatId}: ${topic}`);
                            globalSessionManager.clearSession(topic);
                            break;
                    }
                } catch (error) {
                    log('error', `Error in ${eventName} handler for user ${this.chatId}`, error);
                }
            });
        });
    }
}

// User session storage
const userSignClients = new Map();

// Get or create user sign client
async function getUserSignClient(chatId) {
    if (!userSignClients.has(chatId)) {
        const userClient = new UserSignClient(chatId);
        await userClient.init();
        userSignClients.set(chatId, userClient);
    }
    return userSignClients.get(chatId);
}

// Middleware setup
app.use(cors());
app.use(express.json({ strict: false }));
app.use(express.urlencoded({ extended: true }));

// Middleware to check SignClient
const checkSignClient = async (req, res, next) => {
    try {
        const chatId = req?.body?.chatId || req?.query?.chatId;
        if (!chatId) {
            throw new Error('ChatId is required');
        }
        const userClient = await getUserSignClient(chatId);
        req.userClient = userClient;
        next();
    } catch (error) {
        log('error', 'SignClient check failed', error);
        res.status(503).json({ 
            error: 'SignClient service unavailable', 
            retryAfter: 30 
        });
    }
};

// Connect endpoint
app.post('/connect', checkSignClient, async (req, res) => {
    try {
        const userClient = req.userClient;
        const { uri, approval } = await userClient.signClient.connect({
            requiredNamespaces: {
                eip155: {
                    methods: [
                        'eth_sendTransaction',
                        'eth_sign',
                        'personal_sign',
                        'eth_signTypedData',
                        'eth_signTypedData_v4'
                    ],
                    chains: ['eip155:8453'],
                    events: ['chainChanged', 'accountsChanged', 'connect', 'disconnect'],
                    rpcMap: {
                        8453: 'https://mainnet.base.org'
                    }
                }
            }
        });
       
        const tempTopic = `pending_${Date.now()}`;
        
        // Store initial pending session
        globalSessionManager.createSession(tempTopic, {
            uri,
            approval,
            events: [],
            params: {},
            status: 'pending'
        });

        res.json({ uri, topic: tempTopic });

        try {
            const session = await approval();
            console.log('Approval successful, session:', session);
            
            // Update session with final topic
            const finalTopic = session.topic;
            console.log('Updating session with final topic:', finalTopic);
            
            // Ensure session is saved in WalletConnect client
            if (!userClient.signClient.session.keys.includes(finalTopic)) {
                await userClient.signClient.session.set(finalTopic, session);
            }
            
            // Get the address from namespaces
            const address = session.namespaces.eip155.accounts[0].split(':')[2];
            
            // Update our session manager
            globalSessionManager.updateSession(tempTopic, finalTopic, {
                uri,
                events: [],
                params: {},
                status: 'connected',
                session,
                address
            });

            console.log('Session updated successfully:', {
                topic: finalTopic,
                address,
                sessionKeys: userClient.signClient.session.keys
            });

        } catch (approvalError) {
            console.error('Approval error:', approvalError);
            globalSessionManager.updateSessionStatus(tempTopic, 'failed', approvalError.message);
        }

    } catch (error) {
        log('error', 'Connection error', error);
        res.status(500).json({ error: error.message });
    }
});

// Session status endpoint
app.get('/session-status/:topic', checkSignClient, (req, res) => {
    const requestedTopic = req.params.topic;
    
    console.log('Checking session status for topic:', requestedTopic);
    
    const sessionData = globalSessionManager.getSession(requestedTopic);
    const finalTopic = globalSessionManager.getFinalTopic(requestedTopic);
    
    console.log('Session status check:', {
        sessionData,
        finalTopic,
        allSessions: globalSessionManager.getAllSessions()
    });

    if (!sessionData) {
        console.log('No session found for topic:', requestedTopic);
        res.status(404).json({ error: 'Session not found' });
        return;
    }

    // If we have a finalTopic but status is still pending, something's wrong
    if (finalTopic && sessionData.status === 'pending') {
        sessionData.status = 'connected';
    }

    const response = {
        status: sessionData.status,
        topic: finalTopic || requestedTopic,
        temporary: !finalTopic,
        error: sessionData.error,
        address: sessionData.address
    };

    console.log('Sending response:', response);
    res.json(response);
});

// Fetch session endpoint
app.get('/session/:topic', checkSignClient, async (req, res) => {
  
    try {
        const userClient = req.userClient;
        const { topic } = req.params;
        
        console.log('Fetching session for topic:', topic, {
            availableKeys: userClient.signClient.session.keys
        });

        // First check our session manager
        const managedSession = globalSessionManager.getSession(topic);
        if (managedSession?.session) {
            console.log('Found session in manager:', managedSession);
            return res.json({ session: managedSession.session });
        }

        // Try to get from WalletConnect client
        const session = await userClient.signClient.session.get(topic);
        console.log('Found session in WalletConnect:', session);
        res.json({ session });
    } catch (error) {
        
        log('error', 'Session fetch error', error);
        
        // Try to recover session from our manager as fallback
        const managedSession = globalSessionManager.getSession(req?.params);
        if (managedSession?.session) {
            console.log('Recovered session from manager:', managedSession);
            return res.json({ session: managedSession.session });
        }

        res.status(404).json({ error: 'Session not found' });
    }
});

// Disconnect session endpoint
app.delete('/session/:topic', checkSignClient, async (req, res) => {
    try {
        const userClient = req.userClient;
        const { topic } = req.params;
        await userClient.signClient.disconnect({
            topic,
            reason: { code: 6000, message: 'User requested disconnect' }
        });
        globalSessionManager.clearSession(topic);
        res.json({ success: true });
    } catch (error) {
        log('error', 'Disconnect error', error);
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

// Request endpoint for transactions
app.post('/request/:topic', checkSignClient, async (req, res) => {
    try {
        const userClient = req.userClient;
        const { topic } = req.params;
        const { chainId, request } = req.body;

        log('info', `Incoming request for topic: ${topic}`);
        log('info', `Request payload: ${JSON.stringify({ chainId, request })}`);

        // Check if session exists
        const sessionData = globalSessionManager.getSession(topic);
        if (!sessionData) {
            log('error', `No session found for topic: ${topic}`);
            return res.status(404).json({ error: 'Session not found' });
        }

        // Make the request using the user's SignClient instance
        const result = await userClient.signClient.request({
            topic,
            chainId,
            request
        });

        log('info', 'Request successful', result);
        res.json({ result });
    } catch (error) {
        log('error', 'Request error', error);
        res.status(500).json({
            error: 'Request failed',
            message: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    log('error', 'Unhandled error', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
async function startServer() {
    const PORT = process.env.PORT || 3000;
    try {
        app.listen(PORT, () => {
            log('info', `SignClient service running on port ${PORT}`);
        });
    } catch (error) {
        log('error', 'Failed to start server', error);
        setTimeout(startServer, 5000);
    }
}

startServer();