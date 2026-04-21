// ==========================================
// HEARTBEAT PING - Keep Bot Always On
// ==========================================

const axios = require('axios');

class HeartbeatManager {
    constructor(options = {}) {
        this.interval = options.interval || 30000; // Default 30 seconds
        this.externalPingUrl = options.externalPingUrl || null;
        this.heartbeatId = null;
        this.isActive = false;
    }

    /**
     * Start the heartbeat ping
     * @param {Object} sock - WhatsApp socket connection
     * @param {String} selfJid - Your own WhatsApp JID
     */
    start(sock, selfJid) {
        if (this.isActive) {
            console.log("⚠️  Heartbeat already running");
            return;
        }

        this.isActive = true;
        console.log(`💓 Starting Heartbeat Ping (every ${this.interval / 1000} seconds)`);

        this.heartbeatId = setInterval(async () => {
            try {
                // 1. Internal WhatsApp ping
                if (sock && sock.sendMessage) {
                    await this._pingWhatsApp(sock, selfJid);
                }

                // 2. External ping (for cloud services idle timeout prevention)
                if (this.externalPingUrl) {
                    await this._pingExternal();
                }

                console.log(`💚 Heartbeat OK - ${new Date().toLocaleTimeString()}`);
            } catch (error) {
                console.error("❌ Heartbeat error:", error.message);
            }
        }, this.interval);
    }

    /**
     * Send internal WhatsApp ping
     */
    async _pingWhatsApp(sock, selfJid) {
        try {
            // Get connection state
            const state = sock.user;
            if (!state) {
                console.log("⚠️  WhatsApp not connected yet");
                return;
            }

            // Optional: Send a silent heartbeat message to yourself
            // This keeps the connection active
            await sock.sendMessage(selfJid, {
                text: "💓 Heartbeat",
                viewOnce: true // Send as temporary message
            }).catch(() => {
                // Silently ignore if self-message fails
            });
        } catch (error) {
            console.error("WhatsApp ping error:", error.message);
        }
    }

    /**
     * Send external HTTP ping (for cloud services)
     */
    async _pingExternal() {
        try {
            await axios.get(this.externalPingUrl, { timeout: 5000 });
            console.log("📡 External ping successful");
        } catch (error) {
            console.warn("⚠️  External ping failed:", error.message);
        }
    }

    /**
     * Stop the heartbeat
     */
    stop() {
        if (this.heartbeatId) {
            clearInterval(this.heartbeatId);
            this.heartbeatId = null;
            this.isActive = false;
            console.log("💔 Heartbeat stopped");
        }
    }

    /**
     * Restart the heartbeat
     */
    restart(sock, selfJid) {
        this.stop();
        this.start(sock, selfJid);
    }

    /**
     * Update heartbeat interval
     */
    setInterval(newInterval) {
        this.interval = newInterval;
        console.log(`⏱️  Heartbeat interval updated to ${newInterval / 1000} seconds`);
    }
}

module.exports = { HeartbeatManager };
