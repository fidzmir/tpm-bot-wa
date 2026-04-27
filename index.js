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
// 2. WEBHOOK RECEIVER
// ==========================================

app.get("/", (req, res) => {
    res.send(`
        ✅ Server Bot Aktif! <br> 
        WhatsApp Status: ${sock ? "Connected" : "Connecting..."} <br>
        Heartbeat Status: ${heartbeat.isActive ? "💚 Running" : "💔 Stopped"}
    `);
});

app.post("/", async (req, res) => {
    if (!req.body) {
        console.log("⚠️ Webhook masuk tanpa body data.");
        return res.status(400).send("EMPTY_BODY");
    }

    res.status(200).send("RECEIVED");
    const { message, targetJid } = req.body;

    if (!message || !sock) {
        console.log("⚠️ Pesan kosong atau WA belum terhubung.");
        return;
    }

    try {
        const recipient = targetJid || DEPT_NOTICE_NUMBER;
        await sock.sendMessage(recipient, { text: message });
        console.log("✅ Pesan terkirim ke:", recipient);
    } catch (e) {
        console.error("❌ Gagal mengirim pesan WA:", e.message);
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

const parseMultiSelect = (input, options) => {
    const choices = input.split(/[ ,./]+/).map(v => {
        let num = parseInt(v);
        return num === 0 ? options.length - 1 : num - 1;
    });
    const selected = choices.filter(idx => options[idx]).map(idx => options[idx]);
    return selected.length > 0 ? selected.join(", ") : null;
};

// ==========================================
// 4. MAIN SYSTEM & WHATSAPP LOGIC
// ==========================================

async function startSystem() {
    // FIX: Import both sock and saveCreds function
    const { sock: socketInstance, saveCreds } = await connectToWhatsApp(); 
    sock = socketInstance;

    // CRITICAL FIX: This saves the encryption keys to disk
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log("✅ WHATSAPP TERHUBUNG!");
            const selfJid = sock.user?.id;
            if (selfJid) heartbeat.start(sock, selfJid);
        } else if (connection === 'close') {
            heartbeat.stop();
            console.log("⚠️ Koneksi terputus. Memaksa restart via PM2...");
            // Force process exit so PM2 can restart the bot fresh
            if (lastDisconnect?.error?.output?.statusCode !== 401) {
                process.exit(1); 
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        const senderKey = m.key.participant || m.key.remoteJid;
        const pushName = m.pushName || "User WA";
        const msg = m.message?.ephemeralMessage?.message || m.message;
        const messageType = getContentType(msg);
        const text = (msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || "").trim();

        // --- COMMAND: /CANCEL ---
        if (text.toLowerCase() === "/cancel") {
            if (tpmState[senderKey]) {
                delete tpmState[senderKey];
                return await sock.sendMessage(jid, { text: "🚫 Proses berhasil dibatalkan." });
            }
            return await sock.sendMessage(jid, { text: "⚠️ Tidak ada proses yang sedang berjalan." });
        }

        // --- COMMAND: /OPENLIST ---
        if (text.toLowerCase() === "/openlist") {
            try {
                const res = await axios.get(`${MANUAL_TPM_URL}?action=getList`);
                if (!res.data || res.data.length === 0) return await sock.sendMessage(jid, { text: "✅ Tidak ada tag yang OPEN." });

                let responseMsg = "📋 *DAFTAR TAG AM (OPEN):*\n\n";
                res.data.forEach((item, i) => {
                    responseMsg += `${i + 1}. *${item.tag}*\n 📅 Tgl: ${item.tanggal}\n ⚙️ Mesin: ${item.machine}\n 📄 ${item.desc}\n\n`;
                });
                return await sock.sendMessage(jid, { text: responseMsg });
            } catch (e) { return await sock.sendMessage(jid, { text: "❌ Gagal mengambil data." }); }
        }

        // --- COMMAND: /OPEN [TAG] ---
        if (text.toLowerCase().startsWith("/open ")) {
            const tagCode = text.split(" ")[1].toUpperCase();
            try {
                const res = await axios.get(`${MANUAL_TPM_URL}?action=getDetail&tag=${tagCode}`);
                if (!res.data) return await sock.sendMessage(jid, { text: `❌ Tag *${tagCode}* tidak ditemukan.` });
                
                let caption = `📋 *DETAIL RED TAG*\n\n🏷️ Tag: *${res.data.tag}*\n📅 Tgl: ${res.data.tanggal}\n⚙️ Msn: ${res.data.machine}\n📄 Desc: ${res.data.desc}`;
                const img = formatImageUrl(res.data.photoUrl);
                if (img) await sock.sendMessage(jid, { image: { url: img }, caption });
                else await sock.sendMessage(jid, { text: caption });
            } catch (e) { await sock.sendMessage(jid, { text: "❌ Error detail tag." }); }
            return;
        }

        // --- COMMAND: /CLOSE [TAG] ---
        if (text.toLowerCase().startsWith("/close")) {
            const args = text.split(" ");
            if (args.length < 2) return await sock.sendMessage(jid, { text: "⚠️ Contoh: `/close AM-HPL-001`" });
            tpmState[senderKey] = { step: "CLOSE_PHOTO", tagCode: args[1].toUpperCase(), senderName: pushName };
            tpmState[senderKey].lastBotMsg = await sock.sendMessage(jid, { text: `📸 Kirim *Foto Bukti Close* untuk *${args[1].toUpperCase()}*:` });
            return;
        }

        // --- STATE HANDLING (TPM FLOW) ---
        if (tpmState[senderKey]) {
            const current = tpmState[senderKey];

            if (current.step === "NGOBROL_CHAT") {
                await sock.sendMessage(jid, { text: `🧠 _Gemini berpikir..._` });
                try {
                    const result = await current.chatSession.sendMessage(text);
                    const responseText = result.response.text();
                    const botMsg = await sock.sendMessage(jid, { text: responseText + "\n\n_(Balas untuk lanjut)_" });
                    current.lastBotMsgId = botMsg.key.id;
                } catch (e) { await sock.sendMessage(jid, { text: "❌ Gagal obrolan AI." }); }
                return;
            }

            if (current.step === "CLOSE_PHOTO" && messageType === 'imageMessage') {
                await sock.sendMessage(jid, { text: "⏳ _Memproses..._" });
                try {
                    const buffer = await downloadMediaMessage(m, 'buffer', {});
                    const res = await axios.post(MANUAL_TPM_URL, {
                        action: "closeTag", tagCode: current.tagCode, imageBuffer: buffer.toString('base64')
                    });
                    await sock.sendMessage(jid, { text: res.data === "SUCCESS" ? `✅ Tag *${current.tagCode}* CLOSED.` : "❌ Gagal." });
                } catch (e) { await sock.sendMessage(jid, { text: "❌ Server error." }); }
                delete tpmState[senderKey];
                return;
            }

            // AM INPUT FLOW
            if (current.step === "SELECT_SHEET") {
                const idx = parseInt(text) - 1;
                if (isNaN(idx) || !current.sheets[idx]) return;
                current.targetSheet = current.sheets[idx]; current.step = "SELECT_TAG_DEPT";
                await sock.sendMessage(jid, { text: `✅ Sheet: *${current.targetSheet}*\n\n2. Kode Dept (HPL/ADH/FLR/PVC):` });
            }
            else if (current.step === "SELECT_TAG_DEPT") {
                current.deptTag = text.toUpperCase(); current.step = "MACHINE";
                await sock.sendMessage(jid, { text: `✅ Dept: *${current.deptTag}*\n\n3. Nama Mesin:` });
            }
            else if (current.step === "MACHINE") {
                current.machine = text; current.step = "DESC";
                await sock.sendMessage(jid, { text: `✅ Mesin: *${current.machine}*\n\n4. Deskripsi Singkat Abnormality:` });
            }
            else if (current.step === "DESC") {
                current.description = text; current.step = "PHOTO";
                await sock.sendMessage(jid, { text: `✅ Deskripsi: *${current.description}*\n\n5. Kirim Foto Temuan:` });
            }
            else if (current.step === "PHOTO" && messageType === 'imageMessage') {
                const buffer = await downloadMediaMessage(m, 'buffer', {});
                current.imageBuffer = buffer.toString('base64'); current.step = "CONFIRM";
                await sock.sendMessage(jid, { text: `📝 *KONFIRMASI*\n\nSheet: ${current.targetSheet}\nMesin: ${current.machine}\nDesc: ${current.description}\n\n1. Kirim\n2. Batal` });
            }
            else if (current.step === "CONFIRM" && text === "1") {
                await sock.sendMessage(jid, { text: "⏳ _Mengirim..._" });
                try {
                    await axios.post(MANUAL_TPM_URL, { ...current, action: "saveTag" });
                    await sock.sendMessage(jid, { text: "✅ BERHASIL SIMPAN!" });
                } catch (e) { await sock.sendMessage(jid, { text: "❌ GAGAL SIMPAN!" }); }
                delete tpmState[senderKey];
            }
            return;
        }

        // --- COMMAND: /NGOBROL [DEPT] [QUERY] ---
        if (text.toLowerCase().startsWith("/ngobrol ")) {
            const args = text.split(" ");
            if (args.length < 3) return await sock.sendMessage(jid, { text: "⚠️ Format: `/ngobrol HPL ada masalah apa?`" });
            const dept = args[1].toUpperCase();
            const prompt = args.slice(2).join(" ");
            const sheetMap = { "HPL": "Produksi HPL", "ADH": "Produksi Adhesive", "FLR": "Produksi Flooring", "PVC": "Produksi PVC Cikupa" };
            
            await sock.sendMessage(jid, { text: `🧠 _Gemini menganalisis data ${dept}..._` });
            try {
                const res = await axios.get(`${MANUAL_TPM_URL}?action=getRawData&sheetName=${encodeURIComponent(sheetMap[dept])}`);
                const chatSession = aiModel.startChat({
                    history: [{ role: "user", parts: [{ text: `Data: ${JSON.stringify(res.data)}. Jawab singkat.` }] }, { role: "model", parts: [{ text: "Siap." }] }]
                });
                const result = await chatSession.sendMessage(prompt);
                const botMsg = await sock.sendMessage(jid, { text: result.response.text() + "\n\n_(Balas untuk lanjut)_" });
                tpmState[senderKey] = { step: "NGOBROL_CHAT", chatSession, lastBotMsgId: botMsg.key.id };
            } catch (e) { await sock.sendMessage(jid, { text: "❌ AI Error." }); }
            return;
        }

        // --- COMMAND: /AM ---
        if (text.toLowerCase() === "/am") {
            tpmState[senderKey] = { step: "SELECT_SHEET", senderName: pushName, sheets: ["Produksi HPL", "Produksi Adhesive", "Produksi Flooring", "Produksi PVC Cikupa"] };
            let menu = `Pilih Sheet:\n` + tpmState[senderKey].sheets.map((s, i) => `${i+1}. ${s}`).join("\n");
            await sock.sendMessage(jid, { text: menu });
            return;
        }

        // --- FALLBACK TO SCRIPT GOOGLE ---
        if (text.startsWith('/')) {
            try {
                const res = await axios.post(ORIGINAL_BOT_URL, { command: text, sender: jid });
                if (res.data.type === 'text') await sock.sendMessage(jid, { text: res.data.content });
            } catch (e) { console.log("Fallback fail"); }
        }
    });
}

// Start Server
app.listen(WEBHOOK_PORT, "0.0.0.0", () => {
    console.log(`🚀 Webhook Server Port ${WEBHOOK_PORT}`);
    startSystem();
});
