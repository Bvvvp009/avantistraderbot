// signClientService.js
const { SignClient } = require('@walletconnect/sign-client');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middleware setup
app.use(cors());
app.use(express.json({ strict: false })); // Allow relaxed JSON parsing
app.use(express.urlencoded({ extended: true }));

let signClientInstance = null;
const activeSessions = new Map();
const topicMapping = new Map();

async function initSignClient(retries = 3) {
    for (let i = 0; i < retries; i++) {
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
            console.log('SignClient initialized successfully');
            return true;
        } catch (error) {
            console.error(`SignClient initialization attempt ${i + 1} failed:`, error);
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

function setupEventListeners() {
    signClientInstance.on("session_event", ({ event, session }) => {
        console.log("session_event", event);
        const sessionData = activeSessions.get(session.topic);
        if (sessionData) {
            sessionData.events.push(event);
        }
    });

    signClientInstance.on("session_update", ({ topic, params }) => {
        console.log("session_update", topic, params);
        const sessionData = activeSessions.get(topic);
        if (sessionData) {
            sessionData.params = { ...sessionData.params, ...params };
        }
    });

    signClientInstance.on("session_delete", ({ topic }) => {
        console.log("session_delete", topic);
        
        // Clean up both the session and any mappings
        activeSessions.delete(topic);
        for (const [tempTopic, finalTopic] of topicMapping.entries()) {
          if (finalTopic === topic) {
            topicMapping.delete(tempTopic);
            activeSessions.delete(tempTopic);
          }
        }
      });
      
      // Handle unexpected disconnections
      signClientInstance.on("session_expire", ({ topic }) => {
        console.log("session_expire", topic);
        
        // Clean up both the session and any mappings
        activeSessions.delete(topic);
        for (const [tempTopic, finalTopic] of topicMapping.entries()) {
          if (finalTopic === topic) {
            topicMapping.delete(tempTopic);
            activeSessions.delete(tempTopic);
          }
        }
      });
}

// Middleware to check SignClient status
const checkSignClient = async (req, res, next) => {
    if (!signClientInstance) {
        try {
            await initSignClient();
        } catch (error) {
            console.error('SignClient check failed:', error);
            return res.status(503).json({ error: 'SignClient service unavailable' });
        }
    }
    next();
};

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// API endpoints
// Add a mapping to track temporary to final topics


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
      console.error('Approval error:', approvalError);
      activeSessions.set(tempTopic, {
        ...activeSessions.get(tempTopic),
        status: 'failed',
        error: approvalError.message
      });
    }

  } catch (error) {
    console.error('Connection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Modified session status endpoint
app.get('/session-status/:topic', (req, res) => {
  const requestedTopic = req.params.topic;
  const finalTopic = topicMapping.get(requestedTopic);
  
  // Check both temporary and final topics
  const tempSessionData = activeSessions.get(requestedTopic);
  const finalSessionData = finalTopic ? activeSessions.get(finalTopic) : null;
  
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


app.post('/request/:topic', checkSignClient, async (req, res) => {
    try {
        const { topic } = req.params;
        const { chainId, request } = req.body;

        console.log('Incoming request for topic:', topic);
        console.log('Request payload:', { chainId, request });

        if (!activeSessions.has(topic)) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const result = await signClientInstance.request({
            topic,
            chainId,
            request
        });

        console.log('Request successful:', result);
        res.json({ result });
    } catch (error) {
        console.error('Request error:', error);
        res.status(500).json({
            error: 'Request failed',
            message: error.message
        });
    }
});

app.get('/session/:topic', checkSignClient, async (req, res) => {
    try {
        const { topic } = req.params;
        console.log('Fetching session for topic:', topic);

        const session = await signClientInstance.session.get(topic);
        console.log('Session found:', session.topic);

        res.json({ session });
    } catch (error) {
        console.error('Session fetch error:', error);
        res.status(404).json({ error: 'Session not found' });
    }
});

app.delete('/session/:topic', checkSignClient, async (req, res) => {
    try {
        const { topic } = req.params;
        console.log('Disconnecting session:', topic);

        await signClientInstance.disconnect({
            topic,
            reason: { code: 6000, message: 'User requested disconnect' }
        });

        activeSessions.delete(topic);
        res.json({ success: true });
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({
            error: 'Failed to disconnect',
            message: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// Start the service
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await initSignClient();
        app.listen(PORT, () => {
            console.log(`SignClient service running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Clean up inactive sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [topic, session] of activeSessions.entries()) {
        if (now - session.timestamp > 24 * 60 * 60 * 1000) { // 24 hours
            activeSessions.delete(topic);
            console.log('Cleaned up inactive session:', topic);
        }
    }
}, 60 * 60 * 1000); // Check every hour

startServer();