const { connectToWhatsApp } = require('./session');
const { getContentType, downloadMediaMessage } = require("@whiskeysockets/baileys");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const { HeartbeatManager } = require('./heartbeat');

// ==========================================
// 1. KONFIGURASI & INISIALISASI
// ==========================================
const GEMINI_API_KEY = "AIzaSyC1jxgG9yyjlRb41QCNffTkbxdYlo0Jcx4";
const MANUAL_TPM_URL = "https://script.google.com/macros/s/AKfycbzyBY8Hdhh-2kHEh370mZetwLJGFFUTBD29ZhE8mQAu53-weofI-XU8po2NhwlyfFFI/exec";
const ORIGINAL_BOT_URL = "https://script.google.com/macros/s/AKfycbyknMRVxLOwYy_jwMaOuaQsL_a4Rjwr5eX_9lNMmO64vpoAcKxDsd_x8yQJw85te4M0/exec";
const DEPT_NOTICE_NUMBER = "6285933263178@s.whatsapp.net";
const WEBHOOK_PORT = 8080;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

const tpmState = {};
const app = express();

const heartbeat = new HeartbeatManager({
    interval: 30000, 
    externalPingUrl: null 
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock; 

// ==========================================
// 2. WEBHOOK RECEIVER (FOR GOOGLE SHEETS)
// ==========================================

app.get("/", (req, res) => {
    res.send(`
        ✅ Server Bot Aktif! <br> 
        WhatsApp Status: ${sock ? "Connected" : "Connecting..."} <br>
        Heartbeat Status: ${heartbeat.isActive ? "💚 Running" : "💔 Stopped"}
    `);
});

app.post("/", async (req, res) => {
    // 1. Validasi Body
    if (!req.body || Object.keys(req.body).length === 0) {
        console.log("⚠️ Webhook masuk tanpa body data.");
        return res.status(400).send("EMPTY_BODY");
    }

    // 2. Kirim respon cepat ke Google agar tidak Timeout
    res.status(200).send("RECEIVED");

    const { message, targetJid } = req.body;
    const recipient = targetJid || DEPT_NOTICE_NUMBER;

    console.log(`📩 Webhook Diterima!`);
    console.log(`   - Target: ${recipient}`);
    console.log(`   - Pesan: ${message ? message.substring(0, 30) + "..." : "KOSONG"}`);

    // 3. Validasi Koneksi WA
    if (!sock) {
        console.error("❌ ERROR: WhatsApp 'sock' belum siap. Pesan dibatalkan.");
        return;
    }

    if (!message) {
        console.error("⚠️ ERROR: Isi pesan tidak ditemukan dalam request.");
        return;
    }

    // 4. Kirim Pesan
    try {
        await sock.sendMessage(recipient, { text: message });
        console.log("✅ [WHATSAPP] Pesan berhasil terkirim ke:", recipient);
    } catch (e) {
        console.error("❌ [WHATSAPP] Gagal kirim pesan:", e.message);
    }
});

// Heartbeat Endpoints
app.get("/heartbeat/status", (req, res) => {
    res.json({ isActive: heartbeat.isActive, whatsappConnected: !!sock });
});

app.post("/heartbeat/restart", (req, res) => {
    if (sock && sock.user?.id) {
        heartbeat.restart(sock, sock.user.id);
        res.json({ message: "Heartbeat restarted" });
    } else {
        res.status(400).json({ error: "WA not connected" });
    }
});

// ==========================================
// 3. HELPER FUNCTIONS
// ==========================================

const formatImageUrl = (url) => {
    if (!url) return null;
    if (url.includes("drive.google.com/file/d/")) {
        const fileId = url.split("/d/")[1].split("/")[0];
        return `https://drive.google.com/uc?export=download&id=${fileId}`;
    }
    return url;
};

// ==========================================
// 4. MAIN SYSTEM & WHATSAPP LOGIC
// ==========================================

async function startSystem() {
    console.log("📡 Menghubungkan ke WhatsApp...");
    const { sock: socketInstance, saveCreds } = await connectToWhatsApp(); 
    sock = socketInstance;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log("✅ WHATSAPP TERHUBUNG & SIAP!");
            const selfJid = sock.user?.id;
            if (selfJid) heartbeat.start(sock, selfJid);
        } else if (connection === 'close') {
            heartbeat.stop();
            console.log("⚠️ Koneksi terputus. Memaksa restart via PM2...");
            if (lastDisconnect?.error?.output?.statusCode !== 401) {
                process.exit(1); 
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        const pushName = m.pushName || "User WA";
        const msg = m.message?.ephemeralMessage?.message || m.message;
        const text = (msg?.conversation || msg?.extendedTextMessage?.text || "").trim();

        // (Logika bot interaktif Anda tetap sama di sini...)
        if (text.toLowerCase() === "/ping") {
            await sock.sendMessage(jid, { text: "Pong! 🏓 Bot Aktif." });
        }
    });
}

// Start Server
app.listen(WEBHOOK_PORT, "0.0.0.0", () => {
    console.log(`🚀 Webhook Server Listening on Port ${WEBHOOK_PORT}`);
    startSystem();
});
