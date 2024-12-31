const { SignClient } = require('@walletconnect/sign-client');
const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const app = express();

// Enhanced logging function
function log(level, message, error = null) {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] ${message}`, error ? error : '');
}

// Robust retry mechanism with exponential backoff
async function retryOperation(operation, maxRetries = 5, baseDelay = 1000) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            const delay = baseDelay * Math.pow(2, attempt);
            log('warn', `Operation failed (Attempt ${attempt + 1}/${maxRetries}). Retrying in ${delay}ms`, error);
            
            // Add jitter to prevent thundering herd problem
            const jitteredDelay = delay * (0.7 + Math.random() * 0.6);
            await new Promise(resolve => setTimeout(resolve, jitteredDelay));
        }
    }
    throw new Error('Max retries exceeded');
}

// Middleware setup
app.use(cors());
app.use(express.json({ strict: false }));
app.use(express.urlencoded({ extended: true }));

let signClientInstance = null;
const activeSessions = new Map();
const topicMapping = new Map();

// Global error handler to prevent process exit
process.on('uncaughtException', (error) => {
    log('error', 'Uncaught Exception:', error);
    // Attempt to reinitialize critical services
    initSignClient().catch(initError => {
        log('error', 'Failed to recover from uncaught exception:', initError);
    });
});

process.on('unhandledRejection', (reason, promise) => {
    log('error', 'Unhandled Rejection at:', promise, 'reason:', reason);
});

async function initSignClient(retries = 5) {
    return retryOperation(async () => {
        try {
            signClientInstance = await SignClient.init({
                projectId: process.env.PROJECT_ID,
                metadata: {
                    name: 'Trading Bot',
                    description: 'Trading Bot for Base Chain',
                    url: 'https://walletconnect.com',
                    icons: ['https://avatars.githubusercontent.com/u/37784886']
                }
            });

            setupEventListeners();
            log('info', 'SignClient initialized successfully');
            return true;
        } catch (error) {
            log('error', 'SignClient initialization failed', error);
            throw error;
        }
    }, retries);
}

function setupEventListeners() {
    // Wrap event listeners with error handling
    ['session_event', 'session_update', 'session_delete', 'session_expire'].forEach(eventName => {
        signClientInstance.on(eventName, (data) => {
            try {
                switch(eventName) {
                    case 'session_event':
                        log('info', `Session Event: ${JSON.stringify(data.event)}`);
                        break;
                    case 'session_update':
                        log('info', `Session Update: ${data.topic}`);
                        break;
                    case 'session_delete':
                    case 'session_expire':
                        log('warn', `Session Terminated: ${data.topic}`);
                        break;
                }

                // Cleanup logic remains the same as in previous implementation
                if (eventName === 'session_delete' || eventName === 'session_expire') {
                    activeSessions.delete(data.topic);
                    for (const [tempTopic, finalTopic] of topicMapping.entries()) {
                        if (finalTopic === data.topic) {
                            topicMapping.delete(tempTopic);
                            activeSessions.delete(tempTopic);
                        }
                    }
                }
            } catch (error) {
                log('error', `Error in ${eventName} handler`, error);
            }
        });
    });
}

// Middleware to check SignClient status with recovery
const checkSignClient = async (req, res, next) => {
    try {
        if (!signClientInstance) {
            await initSignClient();
        }
        next();
    } catch (error) {
        log('error', 'SignClient check failed', error);
        res.status(503).json({ 
            error: 'SignClient service temporarily unavailable', 
            retryAfter: 30 
        });
    }
};

// Request logging middleware with error protection
app.use((req, res, next) => {
    const startTime = Date.now();
    
    // Override res.json to log response
    const originalJson = res.json;
    res.json = function(body) {
        const responseTime = Date.now() - startTime;
        log('info', `${req.method} ${req.url} - ${res.statusCode} (${responseTime}ms)`);
        return originalJson.call(this, body);
    };

    next();
});

// Connection endpoint
app.post('/connect', checkSignClient, async (req, res) => {
    try {
        const { uri, approval } = await signClientInstance.connect({
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
    
        // Generate a temporary topic ID
        const tempTopic = `pending_${Date.now()}`;
        
        // Store pending session data
        activeSessions.set(tempTopic, {
            uri,
            approval,
            events: [],
            params: {},
            status: 'pending'
        });

        // Send immediate response with URI and temporary topic
        res.json({ uri, topic: tempTopic });

        try {
            // Handle approval asynchronously
            const session = await approval();
             
            console.log(session)
            // Store the mapping between temporary and final topics
            topicMapping.set(tempTopic, session.topic);
            
            // Add the new session without immediately deleting the temp session
            activeSessions.set(session.topic, {
                uri,
                approval,
                events: [],
                params: {},
                status: 'connected',
                session
            });

            // Set a timeout to clean up the temporary session
            setTimeout(() => {
                activeSessions.delete(tempTopic);
                topicMapping.delete(tempTopic);
            }, 60000); // Keep temp session for 1 minute to allow status checks

        } catch (approvalError) {
            log('error', 'Approval error', approvalError);
            activeSessions.set(tempTopic, {
                ...activeSessions.get(tempTopic),
                status: 'failed',
                error: approvalError.message
            });
        }

    } catch (error) {
        log('error', 'Connection error', error);
        res.status(500).json({ error: error.message });
    }
});

// Session status endpoint
app.get('/session-status/:topic', (req, res) => {
    const requestedTopic = req.params.topic;
    const finalTopic = topicMapping.get(requestedTopic);
    
    // Check both temporary and final topics
    const tempSessionData = activeSessions.get(requestedTopic);
    const finalSessionData = finalTopic ? activeSessions.get(finalTopic) : null;
    console.log(tempSessionData,finalSessionData)
    if (!tempSessionData && !finalSessionData) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }

    // If we have a final session, return that status
    if (finalSessionData) {
        res.json({
            status: 'connected',
            topic: finalTopic,
            temporary: false
        });
        return;
    }

    // Otherwise return the temporary session status
    res.json({
        status: tempSessionData.status,
        topic: requestedTopic,
        temporary: true,
        error: tempSessionData.error
    });
});

// Request endpoint
app.post('/request/:topic', checkSignClient, async (req, res) => {
    try {
        const { topic } = req.params;
        const { chainId, request } = req.body;

        log('info', `Incoming request for topic: ${topic}`);
        log('info', `Request payload: ${JSON.stringify({ chainId, request })}`);

        if (!activeSessions.has(topic)) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const result = await signClientInstance.request({
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

// Fetch session endpoint
app.get('/session/:topic', checkSignClient, async (req, res) => {
    try {
        const { topic } = req.params;
        log('info', `Fetching session for topic: ${topic}`);

        const session = await signClientInstance.session.get(topic);
        log('info', 'Session found', session.topic);

        res.json({ session });
    } catch (error) {
        log('error', 'Session fetch error', error);
        res.status(404).json({ error: 'Session not found' });
    }
});

// Disconnect session endpoint
app.delete('/session/:topic', checkSignClient, async (req, res) => {
    try {
        const { topic } = req.params;
        log('info', `Disconnecting session: ${topic}`);

        await signClientInstance.disconnect({
            topic,
            reason: { code: 6000, message: 'User requested disconnect' }
        });

        activeSessions.delete(topic);
        res.json({ success: true });
    } catch (error) {
        log('error', 'Disconnect error', error);
        res.status(500).json({
            error: 'Failed to disconnect',
            message: error.message
        });
    }
});

// Enhanced error handling middleware
app.use((err, req, res, next) => {
    log('error', 'Unhandled error in request processing', err);
    
    res.status(500).json({
        error: 'Internal server error',
        message: err.message,
        timestamp: new Date().toISOString()
    });
});

// Monitoring and recovery mechanism
function startMonitoring() {
    // Session cleanup
    const sessionCleanupInterval = setInterval(() => {
        try {
            const now = Date.now();
            for (const [topic, session] of activeSessions.entries()) {
                if (now - (session.timestamp || now) > 24 * 60 * 60 * 1000) {
                    activeSessions.delete(topic);
                    log('info', `Cleaned up inactive session: ${topic}`);
                }
            }
        } catch (error) {
            log('error', 'Error in session cleanup', error);
        }
    }, 60 * 60 * 1000);

    // Periodic SignClient health check
    const healthCheckInterval = setInterval(async () => {
        try {
            if (!signClientInstance) {
                await initSignClient();
            }
            // Optional: Add more health checks here
        } catch (error) {
            log('error', 'Health check failed', error);
        }
    }, 30 * 60 * 1000); // Every 30 minutes

    return { sessionCleanupInterval };
}

// Graceful shutdown handler
function gracefulShutdown(intervals) {
    process.on('SIGTERM', async () => {
        log('info', 'SIGTERM received. Shutting down gracefully...');
        
        // Clear intervals
        Object.values(intervals).forEach(clearInterval);

        // Disconnect all active sessions
        for (const topic of activeSessions.keys()) {
            try {
                await signClientInstance.disconnect({
                    topic,
                    reason: { code: 6000, message: 'Server shutdown' }
                });
            } catch (error) {
                log('error', `Error disconnecting session ${topic}`, error);
            }
        }

        process.exit(0);
    });
}

// Start the service
async function startServer() {
    const PORT = process.env.PORT || 3000;

    try {
        // Initialize SignClient
        await initSignClient();

        // Start the server
        const server = app.listen(PORT, () => {
            log('info', `SignClient service running on port ${PORT}`);
        });

        // Setup monitoring and recovery mechanisms
        const intervals = startMonitoring();

        // Setup graceful shutdown
        gracefulShutdown(intervals);

        // Handle server errors
        server.on('error', (error) => {
            log('error', 'Server error', error);
            // Attempt to restart
            startServer().catch(restartError => {
                log('error', 'Failed to restart server', restartError);
            });
        });

    } catch (error) {
        log('error', 'Failed to start server', error);
        // Retry server start
        setTimeout(startServer, 5000);
    }
}

// Initial server start
startServer();