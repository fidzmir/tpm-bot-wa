const { connectToWhatsApp } = require('./session');
const { getContentType, downloadMediaMessage } = require("@whiskeysockets/baileys");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const { HeartbeatManager } = require('./heartbeat');
const fs = require('fs'); // Ditambahkan untuk menghapus folder sesi saat corrupt

// ==========================================
// 1. KONFIGURASI
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
const heartbeat = new HeartbeatManager({ interval: 30000 });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock; 

// ==========================================
// 2. WEBHOOK & SERVER
// ==========================================
app.get("/", (req, res) => {
    res.send(`✅ Bot Aktif! WA: ${sock ? "Connected" : "Connecting..."}`);
});

app.post("/", async (req, res) => {
    if (!req.body || !sock) return res.status(400).send("ERROR");
    res.status(200).send("RECEIVED");
    try {
        const { message, targetJid } = req.body;
        await sock.sendMessage(targetJid || DEPT_NOTICE_NUMBER, { text: message });
    } catch (e) { console.error("Webhook Error:", e.message); }
});

// ==========================================
// 3. HELPERS
// ==========================================
const parseMultiSelect = (input, options) => {
    const choices = input.split(/[ ,./]+/).map(v => {
        let num = parseInt(v);
        return num === 0 ? options.length - 1 : num - 1;
    });
    const selected = choices.filter(idx => options[idx]).map(idx => options[idx]);
    return selected.length > 0 ? selected.join(", ") : null;
};

// ==========================================
// 4. CORE SYSTEM
// ==========================================
async function startSystem() {
    const { sock: socketInstance, saveCreds } = await connectToWhatsApp(); 
    sock = socketInstance;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log("✅ WHATSAPP TERHUBUNG!");
            if (sock.user?.id) heartbeat.start(sock, sock.user.id);
        } 
        
        else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ KONEKSI TERPUTUS! Status Code: ${statusCode}`);

            // 401: Logged out, 403: Forbidden, 500: Bad Session / Corrupt
            const sessionCorrupted = [401, 403, 500];
            const FOLDER_SESI = './auth_info_baileys';

            if (sessionCorrupted.includes(statusCode)) {
                console.log("⚠️ Sesi rusak atau telah dikeluarkan. Menghapus folder auth...");
                try {
                    if (fs.existsSync(FOLDER_SESI)) {
                        fs.rmSync(FOLDER_SESI, { recursive: true, force: true });
                        console.log("🗑️ Folder 'auth_info_baileys' berhasil dibersihkan.");
                    }
                } catch (err) {
                    console.error("Gagal menghapus folder sesi:", err.message);
                }
                console.log("🛑 Sistem dihentikan secara aman. Silakan jalankan ulang untuk scan QR baru.");
                process.exit(0); 
            } else {
                // Gangguan jaringan biasa, biarkan process manager (PM2/Docker) merestart proses
                console.log("🔄 Putus koneksi biasa (Masalah jaringan/Server restart). Merestart bot...");
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

        // [GLOBAL COMMANDS]
        if (text.toLowerCase() === "/cancel") {
            delete tpmState[senderKey];
            return await sock.sendMessage(jid, { text: "🚫 Proses dibatalkan." });
        }

        if (text.toLowerCase() === "/am") {
            tpmState[senderKey] = { step: "SELECT_SHEET", sheets: ["Produksi HPL", "Produksi Adhesive", "Produksi Flooring", "Produksi PVC Cikupa"] };
            let menu = `Halo *${pushName}*!\nPilih Sheet:\n` + tpmState[senderKey].sheets.map((s, i) => `${i+1}. ${s}`).join("\n");
            return await sock.sendMessage(jid, { text: menu });
        }

        if (text.toLowerCase() === "/openlist") {
            const res = await axios.get(`${MANUAL_TPM_URL}?action=getList`);
            let responseMsg = "📋 *DAFTAR TAG OPEN:*\n\n";
            res.data.forEach((item, i) => responseMsg += `${i + 1}. *${item.tag}* - ${item.desc}\n`);
            return await sock.sendMessage(jid, { text: responseMsg });
        }

        // [FITUR OPEN TAG DETAIL]
        if (text.toLowerCase().startsWith("/open ")) {
            const args = text.split(" ");
            const tagCode = args[1]?.toUpperCase();

            if (!tagCode) {
                return await sock.sendMessage(jid, { text: "⚠️ Format salah. Contoh: */open AM-HPL-0001*" });
            }

            await sock.sendMessage(jid, { text: `⏳ Sedang mencari data untuk tag: *${tagCode}*...` });

            try {
                const res = await axios.get(`${MANUAL_TPM_URL}?action=getDetail&tag=${encodeURIComponent(tagCode)}`);
                const data = res.data; 

                if (data && data.tag) { 
                    let detailMsg = `📄 *DETAIL TAG: ${data.tag}*\n\n`;
                    detailMsg += `*Status:* ${data.status}\n`;
                    detailMsg += `*Tanggal:* ${data.tanggal}\n`;
                    detailMsg += `*Mesin:* ${data.machine}\n`;
                    detailMsg += `*Pelapor:* ${data.pelapor}\n`;
                    detailMsg += `*Abnormality:* ${data.abnormality}\n`;
                    detailMsg += `*Contamination:* ${data.contamination}\n`;
                    detailMsg += `*Hard to Access:* ${data.access}\n`;
                    detailMsg += `*Deskripsi:* ${data.desc}\n`;
                    
                    await sock.sendMessage(jid, { text: detailMsg });

                    if (data.photoUrl && data.photoUrl.startsWith('http')) {
                        await sock.sendMessage(jid, { 
                            image: { url: data.photoUrl }, 
                            caption: `📸 Lampiran Foto untuk ${data.tag}` 
                        });
                    }
                    return;
                } else {
                    return await sock.sendMessage(jid, { text: `❌ Data untuk tag *${tagCode}* tidak ditemukan.` });
                }
            } catch (e) {
                console.error("Error fetching tag details:", e.message);
                return await sock.sendMessage(jid, { text: "❌ *ERROR!* Gagal mengambil data dari server Google." });
            }
        }

        // [FITUR CLOSE TAG]
        if (text.toLowerCase().startsWith("/close ")) {
            const args = text.split(" ");
            const tagCode = args[1]?.toUpperCase();

            if (!tagCode) {
                return await sock.sendMessage(jid, { text: "⚠️ Format salah. Contoh: */close AM-HPL-0001*" });
            }

            tpmState[senderKey] = {
                step: "CLOSE_PHOTO",
                tagCode: tagCode
            };
            
            return await sock.sendMessage(jid, { text: `✅ Proses Tutup Tag: *${tagCode}*\n\nSilakan kirimkan *FOTO BUKTI* perbaikan untuk menutup tag ini.\n_(Atau ketik /cancel untuk membatalkan)_` });
        }

        // [FITUR NGOBROL DENGAN AI]
        if (text.toLowerCase().startsWith("/ngobrol ")) {
            const args = text.split(" ");
            const sheetMap = { "HPL": "Produksi HPL", "ADH": "Produksi Adhesive", "FLR": "Produksi Flooring", "PVC": "Produksi PVC Cikupa" };
            const sheetName = sheetMap[args[1]?.toUpperCase()];
            if (!sheetName) return await sock.sendMessage(jid, { text: "Format salah. Contoh: /ngobrol HPL ada berapa tag?" });
            
            const res = await axios.get(`${MANUAL_TPM_URL}?action=getRawData&sheetName=${encodeURIComponent(sheetName)}`);
            const chat = aiModel.startChat({ history: [{ role: "user", parts: [{ text: `Data: ${JSON.stringify(res.data)}` }] }] });
            const result = await chat.sendMessage(args.slice(2).join(" "));
            const botMsg = await sock.sendMessage(jid, { text: result.response.text() });
            tpmState[senderKey] = { step: "NGOBROL_CHAT", chatSession: chat, lastBotMsgId: botMsg.key.id };
            return;
        }

        // [TPM STATE FLOW]
        if (tpmState[senderKey]) {
            const current = tpmState[senderKey];

            if (current.step === "NGOBROL_CHAT") {
                const result = await current.chatSession.sendMessage(text);
                return await sock.sendMessage(jid, { text: result.response.text() + "\n\n_(Balas untuk lanjut)_" });
            }

            // --- ALUR INPUT RED TAG ---
            if (current.step === "SELECT_SHEET") {
                const idx = parseInt(text) - 1;
                if (current.sheets[idx]) {
                    current.targetSheet = current.sheets[idx];
                    current.step = "SELECT_TAG_DEPT";
                    return await sock.sendMessage(jid, { text: `✅ Sheet: *${current.targetSheet}*\n\n2. Kode Dept (HPL/ADH/FLR/PVC):` });
                }
            } else if (current.step === "SELECT_TAG_DEPT") {
                current.deptTag = text.toUpperCase(); current.step = "MACHINE";
                return await sock.sendMessage(jid, { text: `✅ Dept: *${current.deptTag}*\n\n3. Nama Mesin:` });
            } else if (current.step === "MACHINE") {
                current.machine = text; current.step = "ABNORMAL";
                current.opts = ["Bocor", "Usang", "Rusak", "Kendur", "Hilang", "Cacat", "Lain-Lain"];
                let menu = `✅ Mesin: *${current.machine}*\n\n4. Pilih *Abnormality* (Contoh: 1,3):\n`;
                current.opts.forEach((o, i) => menu += `${i + 1}. ${o}\n`);
                return await sock.sendMessage(jid, { text: menu });
            } else if (current.step === "ABNORMAL") {
                current.abnormality = parseMultiSelect(text, current.opts);
                current.step = "CONTAM";
                current.opts = ["Pelumas", "Air/Cairan", "Produk", "Limbah", "Kotoran", "Korosi"];
                let menu = `✅ Abnormal: *${current.abnormality}*\n\n5. Pilih *Contamination*:\n`;
                current.opts.forEach((o, i) => menu += `${i + 1}. ${o}\n`);
                return await sock.sendMessage(jid, { text: menu });
            } else if (current.step === "CONTAM") {
                current.contamination = parseMultiSelect(text, current.opts);
                current.step = "ACCESS";
                current.opts = ["Membersihkan", "Memeriksa", "Melumasi", "Mengganti", "Mengencangkan"];
                let menu = `✅ Contam: *${current.contamination}*\n\n6. Pilih *Hard To Access*:\n`;
                current.opts.forEach((o, i) => menu += `${i + 1}. ${o}\n`);
                return await sock.sendMessage(jid, { text: menu });
            } else if (current.step === "ACCESS") {
                current.access = parseMultiSelect(text, current.opts);
                current.step = "DESC";
                return await sock.sendMessage(jid, { text: `✅ Access: *${current.access}*\n\n7. Deskripsi Singkat:` });
            } else if (current.step === "DESC") {
                current.description = text; current.step = "PHOTO";
                return await sock.sendMessage(jid, { text: `✅ Desk: *${current.description}*\n\n8. Kirim Foto Temuan:` });
            } else if (current.step === "PHOTO" && messageType === 'imageMessage') {
                const buffer = await downloadMediaMessage(m, 'buffer', {});
                current.imageBuffer = buffer.toString('base64');
                current.step = "CONFIRM";
                return await sock.sendMessage(jid, { text: `📝 *KONFIRMASI*\n\nSheet: ${current.targetSheet}\nMesin: ${current.machine}\n\n1. Kirim\n2. Batal` });
            } else if (current.step === "CONFIRM" && text === "1") {
                await sock.sendMessage(jid, { text: "⏳ Sedang memproses ke Google Sheets..." });
                try {
                    const response = await axios.post(MANUAL_TPM_URL, { ...current, action: "saveTag", senderName: pushName });
                    if (response.data === "OK") {
                        await sock.sendMessage(jid, { text: "✅ *BERHASIL!* Data Red Tag telah tercatat." });
                    } else {
                        await sock.sendMessage(jid, { text: `❌ *GAGAL!* Server merespon: ${response.data}` });
                    }
                } catch (e) {
                    await sock.sendMessage(jid, { text: "❌ *ERROR!* Koneksi terputus." });
                }
                delete tpmState[senderKey];
                return;
            }

            // --- ALUR PROSES CLOSE TAG ---
            else if (current.step === "CLOSE_PHOTO") {
                if (messageType !== 'imageMessage') {
                    return await sock.sendMessage(jid, { text: "⚠️ Harap kirimkan berupa FOTO bukti perbaikan (bukan dokumen/teks)." });
                }
                const buffer = await downloadMediaMessage(m, 'buffer', {});
                current.imageBuffer = buffer.toString('base64');
                current.step = "CLOSE_CONFIRM";
                return await sock.sendMessage(jid, { text: `📝 *KONFIRMASI TUTUP TAG*\n\nTag: ${current.tagCode}\n\n1. Konfirmasi Tutup\n2. Batal` });
            } 
            else if (current.step === "CLOSE_CONFIRM") {
                if (text === "1") {
                    await sock.sendMessage(jid, { text: "⏳ Sedang memproses penutupan tag ke database..." });
                    try {
                        const response = await axios.post(MANUAL_TPM_URL, { 
                            action: "closeTag", 
                            tagCode: current.tagCode, 
                            imageBuffer: current.imageBuffer 
                        });
                        
                        if (response.data === "SUCCESS") {
                            await sock.sendMessage(jid, { text: `✅ *BERHASIL!* Tag *${current.tagCode}* telah ditutup (CLOSE).` });
                        } else if (response.data === "NOT_FOUND") {
                            await sock.sendMessage(jid, { text: `❌ *GAGAL!* Tag *${current.tagCode}* tidak ditemukan di database.` });
                        } else {
                            await sock.sendMessage(jid, { text: `❌ *GAGAL!* Server merespon: ${response.data}` });
                        }
                    } catch (e) {
                        await sock.sendMessage(jid, { text: "❌ *ERROR!* Koneksi terputus." });
                    }
                } else {
                    await sock.sendMessage(jid, { text: "🚫 Penutupan tag dibatalkan." });
                }
                delete tpmState[senderKey];
                return;
            }

            return; // Exit flow tpmState
        }

        // [FALLBACK LAMA]
        if (text.startsWith('/')) {
            const res = await axios.post(ORIGINAL_BOT_URL, { command: text, sender: jid });
            if (res.data.type === 'text') await sock.sendMessage(jid, { text: res.data.content });
        }
    });
}

app.listen(WEBHOOK_PORT, "0.0.0.0", () => {
    console.log(`🚀 Server on port ${WEBHOOK_PORT}`);
    startSystem();
});
