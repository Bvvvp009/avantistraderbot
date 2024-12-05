const { SignClient } = require('@walletconnect/sign-client');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

let signClientInstance = {};
const activeSessions = new Map(); // Store active sessions

// Initialize SignClient with retry mechanism
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
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

function setupEventListeners() {
  signClientInstance.on("session_event", ({ event, session }) => {
    console.log("session_event", event);
    activeSessions.get(session.topic)?.events.push(event);
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
    activeSessions.delete(topic);
  });

  // Handle unexpected disconnections
  signClientInstance.on("session_expire", ({ topic }) => {
    console.log("session_expire", topic);
    activeSessions.delete(topic);
  });
}

// Middleware to check SignClient status
const checkSignClient = async (req, res, next) => {
  if (!signClientInstance) {
    try {
      await initSignClient();
      console.log("Instance running")
    } catch (error) {
      return res.status(503).json({ error: 'SignClient service unavailable' });
    }
  }
  next();
};

// API endpoints
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
  
      // Generate a temporary topic ID before approval
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
        
        // Update session with actual topic
        activeSessions.delete(tempTopic);
        activeSessions.set(session.topic, {
          uri,
          approval,
          events: [],
          params: {},
          status: 'connected',
          session
        });
  
        // Add endpoint to check session status
        app.get('/session-status/:topic', (req, res) => {
          const sessionData = activeSessions.get(req.params.topic);
          if (!sessionData) {
            res.status(404).json({ error: 'Session not found' });
          } else {
            res.json({
              status: sessionData.status,
              topic: sessionData.status === 'connected' ? sessionData.session.topic : req.params.topic
            });
          }
        });
  
      } catch (approvalError) {
        console.error('Approval error:', approvalError);
        activeSessions.delete(tempTopic);
      }
  
    } catch (error) {
      console.error('Connection error:', error);
      res.status(500).json({ error: error.message });
    }
  });

app.post('/request/:topic', checkSignClient, async (req, res) => {
  try {
    const { topic } = req.params;
    const { chainId, request } = req.body;

    if (!activeSessions.has(topic)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await signClientInstance.request({
      topic,
      chainId,
      request
    });

    res.json({ result });
  } catch (error) {
    console.error('Request error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/session/:topic', checkSignClient, async (req, res) => {
  try {
    const { topic } = req.params;
    const session = await signClientInstance.session.get(topic);
    res.json({ session });
  } catch (error) {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.delete('/session/:topic', checkSignClient, async (req, res) => {
  try {
    const { topic } = req.params;
    await signClientInstance.disconnect({
      topic,
      reason: { code: 6000, message: 'User requested disconnect' }
    });
    activeSessions.delete(topic);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    signClientInitialized: !!signClientInstance,
    activeSessions: activeSessions.size
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
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

startServer();