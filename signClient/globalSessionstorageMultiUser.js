// globalSessionManager.js

class GlobalSessionManager {
    constructor() {
        this.activeSessions = new Map();
        this.topicMapping = new Map();
        this.sessionTimeouts = new Map();
        
        // Cleanup interval for expired sessions
        setInterval(() => this.cleanupExpiredSessions(), 30 * 60 * 1000);
    }

    createSession(tempTopic, sessionData) {
        try {
            const fullSessionData = {
                ...sessionData,
                status: sessionData.status || 'pending',
                timestamp: Date.now()
            };

            this.activeSessions.set(tempTopic, fullSessionData);

            // Set timeout for temporary topics
            this.setSessionTimeout(tempTopic);

            return tempTopic;
        } catch (error) {
            console.error('Error creating session:', error);
            throw error;
        }
    }

    updateSession(tempTopic, finalTopic, finalSessionData) {
        try {
            // Log current state for debugging
            console.log('Updating session:', {
                tempTopic,
                finalTopic,
                currentMapping: this.topicMapping.get(tempTopic),
                currentSession: this.activeSessions.get(tempTopic)
            });

            // Clear temporary topic timeout
            this.clearSessionTimeout(tempTopic);

            // Map temporary topic to final topic
            this.topicMapping.set(tempTopic, finalTopic);

            const fullSessionData = {
                ...finalSessionData,
                status: 'connected',
                timestamp: Date.now(),
                originalTempTopic: tempTopic // Keep track of original temp topic
            };

            // Store final session data in both locations
            this.activeSessions.set(finalTopic, fullSessionData);
            
            // Update temp session to point to final session
            const tempSessionData = this.activeSessions.get(tempTopic);
            if (tempSessionData) {
                this.activeSessions.set(tempTopic, {
                    ...tempSessionData,
                    status: 'connected',
                    finalTopic
                });
            }

            // Set timeout for final topic
            this.setSessionTimeout(finalTopic, 24 * 60 * 60 * 1000); // 24 hours for connected sessions

            console.log('Session updated:', {
                tempTopic,
                finalTopic,
                newMapping: this.topicMapping.get(tempTopic),
                newSession: this.activeSessions.get(finalTopic)
            });

            return finalTopic;
        } catch (error) {
            console.error('Error updating session:', error);
            throw error;
        }
    }

    getSession(topic) {
        try {
            // Direct access
            const directSession = this.activeSessions.get(topic);
            if (directSession) return directSession;

            // Check mapped topic
            const finalTopic = this.topicMapping.get(topic);
            if (finalTopic) {
                return this.activeSessions.get(finalTopic);
            }

            return null;
        } catch (error) {
            console.error('Error getting session:', error);
            return null;
        }
    }

    getFinalTopic(tempTopic) {
        return this.topicMapping.get(tempTopic) || null;
    }

    clearSession(topic) {
        try {
            const finalTopic = this.topicMapping.get(topic) || topic;
            
            // Clear timeouts
            this.clearSessionTimeout(topic);
            this.clearSessionTimeout(finalTopic);

            // Clear session data
            this.activeSessions.delete(topic);
            this.activeSessions.delete(finalTopic);
            this.topicMapping.delete(topic);

            return true;
        } catch (error) {
            console.error('Error clearing session:', error);
            return false;
        }
    }

    setSessionTimeout(topic, duration = 60000) { // Default 1 minute for pending sessions
        const timeoutId = setTimeout(() => {
            this.clearSession(topic);
        }, duration);

        this.sessionTimeouts.set(topic, timeoutId);
    }

    clearSessionTimeout(topic) {
        const timeoutId = this.sessionTimeouts.get(topic);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.sessionTimeouts.delete(topic);
        }
    }

    cleanupExpiredSessions() {
        const now = Date.now();
        for (const [topic, session] of this.activeSessions.entries()) {
            const maxAge = session.status === 'pending' ? 60000 : 24 * 60 * 60 * 1000;
            if (now - session.timestamp > maxAge) {
                this.clearSession(topic);
            }
        }
    }

    getAllSessions() {
        return Array.from(this.activeSessions.entries()).map(([topic, session]) => ({
            topic,
            finalTopic: this.topicMapping.get(topic),
            ...session
        }));
    }

    updateSessionStatus(topic, status, error = null) {
        const session = this.getSession(topic);
        if (session) {
            session.status = status;
            if (error) session.error = error;
            session.timestamp = Date.now();
            this.activeSessions.set(topic, session);
        }
    }
}

// Create a singleton instance
const globalSessionManager = new GlobalSessionManager();

module.exports = globalSessionManager;