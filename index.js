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

// ==========================================
// HEARTBEAT CONFIGURATION
// ==========================================
const heartbeat = new HeartbeatManager({
    interval: 30000, // Ping every 30 seconds
    externalPingUrl: null 
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock; 

// ==========================================
// 2. WEBHOOK RECEIVER (FIXED)
// ==========================================

app.get("/", (req, res) => {
    res.send(`
        ✅ Server Bot Aktif! <br> 
        WhatsApp Status: ${sock ? "Connected" : "Connecting..."} <br>
        Heartbeat Status: ${heartbeat.isActive ? "💚 Running" : "💔 Stopped"}
    `);
});

app.post("/", async (req, res) => {
    // 1. Validasi awal: Pastikan body ada untuk mencegah crash
    if (!req.body) {
        console.log("⚠️ Webhook masuk tanpa body data.");
        return res.status(400).send("EMPTY_BODY");
    }

    // Balas langsung ke Google Sheets agar script di Sheets cepat selesai
    res.status(200).send("RECEIVED");

    const { message, targetJid } = req.body;

    // 2. Validasi isi pesan
    if (!message) {
        console.log("⚠️ Webhook masuk tapi field 'message' kosong.");
        return;
    }

    // Proses pengiriman WA di latar belakang
    if (!sock) {
        console.log("❌ Webhook masuk tapi WA belum terhubung!");
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

// ==========================================
// HEARTBEAT CONTROL ENDPOINTS
// ==========================================

app.get("/heartbeat/status", (req, res) => {
    res.json({
        isActive: heartbeat.isActive,
        interval: heartbeat.interval,
        whatsappConnected: !!sock
    });
});

app.post("/heartbeat/interval", (req, res) => {
    const { interval } = req.body;
    if (!interval || interval < 5000) {
        return res.status(400).json({ error: "Interval must be at least 5000ms (5 seconds)" });
    }
    heartbeat.setInterval(interval);
    res.json({ 
        message: `Heartbeat interval changed to ${interval}ms`,
        interval: heartbeat.interval 
    });
});

app.post("/heartbeat/stop", (req, res) => {
    heartbeat.stop();
    res.json({ message: "Heartbeat stopped" });
});

app.post("/heartbeat/restart", (req, res) => {
    if (sock) {
        const selfJid = sock.user?.id;
        if (selfJid) {
            heartbeat.restart(sock, selfJid);
            res.json({ message: "Heartbeat restarted" });
        } else {
            res.status(400).json({ error: "WhatsApp not connected properly" });
        }
    } else {
        res.status(400).json({ error: "WhatsApp not connected" });
    }
});

app.listen(WEBHOOK_PORT, "0.0.0.0", () => {
    console.log(`\n🚀 ==========================================`);
    console.log(`✅ Webhook Server siap di port ${WEBHOOK_PORT}`);
    console.log(`✅ Pastikan Port ${WEBHOOK_PORT} di Codespaces set PUBLIC`);
    console.log(`✅ Visit: http://localhost:${WEBHOOK_PORT}`);
    console.log(`🚀 ==========================================\n`);
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
    if (url.includes("thumbnail.googleusercontent.com/doc/")) {
        const fileId = url.split("/doc/")[1].split("?")[0];
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
// 4. MAIN SYSTEM
// ==========================================

async function startSystem() {
    sock = await connectToWhatsApp(); 

    sock.ev.on('connection.update', (update) => {
        if (update.connection === 'open') {
            const selfJid = sock.user?.id;
            if (selfJid) {
                heartbeat.start(sock, selfJid);
            }
        } else if (update.connection === 'close') {
            heartbeat.stop();
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

        // [0] FEATURE: /CANCEL
        if (text.toLowerCase() === "/cancel") {
            if (tpmState[senderKey]) {
                delete tpmState[senderKey];
                return await sock.sendMessage(jid, { text: "🚫 Proses berhasil dibatalkan." });
            } else {
                return await sock.sendMessage(jid, { text: "⚠️ Tidak ada proses yang sedang berjalan." });
            }
        }

        // [1] FEATURE: /OPENLIST
        if (text.toLowerCase() === "/openlist") {
            try {
                const res = await axios.get(`${MANUAL_TPM_URL}?action=getList`);
                if (!res.data || res.data.length === 0) return await sock.sendMessage(jid, { text: "✅ Tidak ada tag yang OPEN saat ini." });

                let responseMsg = "📋 *DAFTAR TAG AM (OPEN):*\n\n";
                res.data.forEach((item, i) => {
                    responseMsg += `${i + 1}. *${item.tag}*\n 📅 Tgl: ${item.tanggal || "-"}\n ⚙️ Mesin: ${item.machine || "-"}\n 📄 ${item.desc}\n\n`;
                });
                responseMsg += "Gunakan `/open [KODE_TAG]` untuk detail atau `/close [KODE_TAG]` untuk menutup.";
                return await sock.sendMessage(jid, { text: responseMsg });
            } catch (e) {
                return await sock.sendMessage(jid, { text: "❌ Gagal mengambil data list." });
            }
        }

        // [2] FEATURE: /OPEN [KODE TAG]
        if (text.toLowerCase().startsWith("/open ")) {
            const tagCode = text.split(" ")[1].toUpperCase();
            try {
                const res = await axios.get(`${MANUAL_TPM_URL}?action=getDetail&tag=${tagCode}`);
                const item = res.data;

                if (!item) return await sock.sendMessage(jid, { text: `❌ Tag *${tagCode}* tidak ditemukan.` });

                let caption = `📋 *DETAIL RED TAG*\n\n🏷️ Tag: *${item.tag}*\n📅 Tgl: ${item.tanggal}\n⚙️ Msn: ${item.machine}\n📄 Desc: ${item.desc}\n\n`;
                const finalImageUrl = formatImageUrl(item.photoUrl);

                if (finalImageUrl) {
                    await sock.sendMessage(jid, {
                        image: { url: finalImageUrl },
                        caption: caption
                    }).catch(async () => {
                        await sock.sendMessage(jid, { text: caption + "⚠️ _Gagal memuat foto, cek manual di sheet._" });
                    });
                } else {
                    await sock.sendMessage(jid, { text: caption + "⚠️ _Foto tidak tersedia._" });
                }
            } catch (e) {
                await sock.sendMessage(jid, { text: "❌ Gagal mengambil detail tag." });
            }
            return;
        }

        // [3] FEATURE: /CLOSE
        if (text.toLowerCase().startsWith("/close")) {
            const args = text.split(" ");
            if (args.length < 2) return await sock.sendMessage(jid, { text: "⚠️ Format salah. Contoh: `/close AM-HPL-001`" });

            const tagToClose = args[1].toUpperCase();
            tpmState[senderKey] = {
                step: "CLOSE_PHOTO",
                tagCode: tagToClose,
                senderName: pushName
            };
            tpmState[senderKey].lastBotMsg = await sock.sendMessage(jid, { text: `📸 Menutup tag *${tagToClose}*.\n\nSilahkan kirim *Foto Bukti Close*:` });
            return;
        }

        // [4] STATE HANDLING (CORE LOGIC)
        if (tpmState[senderKey]) {
            const current = tpmState[senderKey];

            // --- FLOW NGOBROL (GEMINI) ---
            if (current.step === "NGOBROL_CHAT") {
                const isReply = m.message.extendedTextMessage?.contextInfo?.stanzaId === current.lastBotMsgId;
                const isGroup = jid.endsWith("@g.us");
                if (isGroup && !isReply) return;

                await sock.sendMessage(jid, { text: `🧠 _Gemini sedang berpikir..._` });

                try {
                    const result = await current.chatSession.sendMessage(text);
                    let responseText = result.response.text();

                    const chartMatch = responseText.match(/\[CHART_JSON\]([\s\S]*?)\[\/CHART_JSON\]/);
                    if (chartMatch) {
                        const jsonStr = chartMatch[1].trim();
                        const chartUrl = `https://quickchart.io/chart?w=500&h=300&c=${encodeURIComponent(jsonStr)}`;
                        responseText = responseText.replace(chartMatch[0], "").trim();

                        const botMsg = await sock.sendMessage(jid, {
                            image: { url: chartUrl },
                            caption: responseText + "\n\n📊 _(Balas untuk diskusi lanjut)_"
                        });
                        current.lastBotMsgId = botMsg.key.id;
                    } else {
                        const botMsg = await sock.sendMessage(jid, { text: responseText + "\n\n_(Balas pesan ini untuk lanjut)_" });
                        current.lastBotMsgId = botMsg.key.id;
                    }
                } catch (error) {
                    await sock.sendMessage(jid, { text: "❌ Gagal melanjutkan obrolan." });
                }
                return;
            }

            // --- FLOW CLOSE PHOTO ---
            if (current.step === "CLOSE_PHOTO") {
                if (messageType === 'imageMessage') {
                    await sock.sendMessage(jid, { text: "⏳ _Memproses penutupan tag..._" });
                    try {
                        const buffer = await downloadMediaMessage(m, 'buffer', {});
                        const res = await axios.post(MANUAL_TPM_URL, {
                            action: "closeTag",
                            tagCode: current.tagCode,
                            imageBuffer: buffer.toString('base64')
                        });

                        if (res.data === "SUCCESS") {
                            await sock.sendMessage(jid, { text: `✅ Berhasil! Tag *${current.tagCode}* telah CLOSED.` });
                        } else {
                            await sock.sendMessage(jid, { text: `❌ Gagal: Tag tidak ditemukan atau sudah closed.` });
                        }
                    } catch (e) { await sock.sendMessage(jid, { text: "❌ Error server saat menutup tag." }); }
                    delete tpmState[senderKey];
                }
                return;
            }

            // --- FLOW /AM (INPUT STEP BY STEP) ---
            if (current.step === "SELECT_SHEET") {
                const idx = parseInt(text) - 1;
                if (isNaN(idx) || !current.sheets[idx]) return await sock.sendMessage(jid, { text: "⚠️ Pilihan tidak valid." });
                current.targetSheet = current.sheets[idx]; current.step = "SELECT_TAG_DEPT";
                await sock.sendMessage(jid, { text: `✅ Sheet: *${current.targetSheet}*\n\n2. Kode Dept (HPL/ADH/FLR/PVC):`, edit: current.lastBotMsg.key });
            }
            else if (current.step === "SELECT_TAG_DEPT") {
                current.deptTag = text.toUpperCase(); current.step = "MACHINE";
                await sock.sendMessage(jid, { text: `✅ Dept: *${current.deptTag}*\n\n3. Nama Mesin:`, edit: current.lastBotMsg.key });
            }
            else if (current.step === "MACHINE") {
                current.machine = text; current.step = "ABNORMAL";
                current.opts = ["Bocor", "Usang", "Rusak", "Kendur", "Hilang", "Cacat", "Lain-Lain", "None"];
                let menu = `✅ Mesin: *${current.machine}*\n\n4. Pilih *Abnormality*:\n0. None\n`;
                current.opts.slice(0, -1).forEach((o, i) => menu += `${i + 1}. ${o}\n`);
                await sock.sendMessage(jid, { text: menu, edit: current.lastBotMsg.key });
            }
            else if (current.step === "ABNORMAL") {
                const res = parseMultiSelect(text, current.opts);
                if (!res) return await sock.sendMessage(jid, { text: "⚠️ Pilihan tidak valid." });
                current.abnormality = res; current.step = "CONTAM";
                current.opts = ["Pelumas", "Air/Cairan", "Produk", "Limbah", "Kotoran", "Korosi", "None"];
                let menu = `✅ Abnormality: *${current.abnormality}*\n\n5. Pilih *Contamination*:\n0. None\n`;
                current.opts.slice(0, -1).forEach((o, i) => menu += `${i + 1}. ${o}\n`);
                await sock.sendMessage(jid, { text: menu, edit: current.lastBotMsg.key });
            }
            else if (current.step === "CONTAM") {
                const res = parseMultiSelect(text, current.opts);
                current.contamination = res; current.step = "ACCESS";
                current.opts = ["Membersihkan", "Memeriksa", "Melumasi", "Mengganti", "Mengencangkan", "None"];
                let menu = `✅ Contamination: *${current.contamination}*\n\n6. Pilih *Hard To Access*:\n0. None\n`;
                current.opts.slice(0, -1).forEach((o, i) => menu += `${i + 1}. ${o}\n`);
                await sock.sendMessage(jid, { text: menu, edit: current.lastBotMsg.key });
            }
            else if (current.step === "ACCESS") {
                const res = parseMultiSelect(text, current.opts);
                current.access = res; current.step = "DESC";
                await sock.sendMessage(jid, { text: `✅ Access: *${current.access}*\n\n7. Deskripsi Singkat:`, edit: current.lastBotMsg.key });
            }
            else if (current.step === "DESC") {
                current.description = text; current.step = "PHOTO";
                await sock.sendMessage(jid, { text: `✅ Deskripsi: *${current.description}*\n\n8. Kirim Foto Temuan:`, edit: current.lastBotMsg.key });
            }
            else if (messageType === 'imageMessage' && current.step === "PHOTO") {
                try {
                    const buffer = await downloadMediaMessage(m, 'buffer', {});
                    current.imageBuffer = buffer.toString('base64'); current.step = "CONFIRM";
                    let review = `📝 *KONFIRMASI RED TAG*\n\n📍 Sheet: *${current.targetSheet}*\n⚙️ Mesin: *${current.machine}*\n⚠️ Abnormal: *${current.abnormality}*\n🧫 Contam: *${current.contamination}*\n🚫 Access: *${current.access}*\n✍️ Deskripsi: *${current.description}*\n\n1. Kirim\n2. Batal`;
                    await sock.sendMessage(jid, { text: review, edit: current.lastBotMsg.key });
                } catch (error) { await sock.sendMessage(jid, { text: "❌ Gagal mengunduh foto." }); }
            }
            else if (current.step === "CONFIRM") {
                if (text === "1") {
                    await sock.sendMessage(jid, { text: "⏳ _Mengirim data ke Spreadsheet..._", edit: current.lastBotMsg.key });
                    try {
                        await axios.post(MANUAL_TPM_URL, {
                            targetSheet: current.targetSheet, deptTag: current.deptTag, machine: current.machine,
                            senderName: current.senderName, abnormality: current.abnormality, contamination: current.contamination,
                            access: current.access, description: current.description, imageBuffer: current.imageBuffer
                        });
                        current.step = "ASK_NOTICE";
                        await sock.sendMessage(jid, { text: `🎉 *BERHASIL SIMPAN!*\n\nKirim NOTICE ke Departemen?\n1. Ya (Kirim WA)\n2. Tidak (Selesai)`, edit: current.lastBotMsg.key });
                    } catch (e) {
                        await sock.sendMessage(jid, { text: "❌ GAGAL SIMPAN!", edit: current.lastBotMsg.key });
                        delete tpmState[senderKey];
                    }
                } else {
                    await sock.sendMessage(jid, { text: "❌ Dibatalkan.", edit: current.lastBotMsg.key });
                    delete tpmState[senderKey];
                }
            }
            else if (current.step === "ASK_NOTICE") {
                if (text === "1") {
                    let noticeMsg = `📢 *TPM NOTICE*\n\n🏷️ *Tag:* AM-${current.deptTag}-NEW\n⚙️ *Mesin:* ${current.machine}\n👤 *Pelapor:* ${current.senderName}`;
                    await sock.sendMessage(DEPT_NOTICE_NUMBER, { text: noticeMsg });
                    await sock.sendMessage(jid, { text: "✅ Notice Terkirim.", edit: current.lastBotMsg.key });
                } else {
                    await sock.sendMessage(jid, { text: "👍 Selesai.", edit: current.lastBotMsg.key });
                }
                delete tpmState[senderKey];
            }
            return;
        }

        // [5] FEATURE: /NGOBROL (Gemini AI Analysis)
        if (text.toLowerCase().startsWith("/ngobrol ")) {
            const args = text.trim().split(/\s+/);
            if (args.length < 3) return await sock.sendMessage(jid, { text: "⚠️ Format: `/ngobrol HPL apa yang rusak?`" });

            const deptCode = args[1].toUpperCase();
            const promptUser = args.slice(2).join(" ");
            const sheetMap = { "HPL": "Produksi HPL", "ADH": "Produksi Adhesive", "FLR": "Produksi Flooring", "PVC": "Produksi PVC Cikupa" };
            const targetSheet = sheetMap[deptCode];

            if (!targetSheet) return await sock.sendMessage(jid, { text: `⚠️ Kode Dept tidak dikenal (HPL, ADH, FLR, PVC).` });

            await sock.sendMessage(jid, { text: `🧠 _Gemini sedang menganalisis data ${deptCode}..._` });

            try {
                const res = await axios.get(`${MANUAL_TPM_URL}?action=getRawData&sheetName=${encodeURIComponent(targetSheet)}`);
                const sheetData = res.data;

                const systemPrompt = `Anda asisten AI TPM pabrik. Data JSON: ${JSON.stringify(sheetData)}. Gunakan [CHART_JSON]...[/CHART_JSON] untuk grafik.`;
                const chatSession = aiModel.startChat({
                    history: [
                        { role: "user", parts: [{ text: systemPrompt }] },
                        { role: "model", parts: [{ text: "Siap membantu." }] }
                    ]
                });

                const result = await chatSession.sendMessage(promptUser);
                let responseText = result.response.text();

                const chartMatch = responseText.match(/\[CHART_JSON\]([\s\S]*?)\[\/CHART_JSON\]/);
                let payload = { text: responseText + "\n\n_(Balas untuk diskusi lanjut)_" };

                if (chartMatch) {
                    const jsonStr = chartMatch[1].trim();
                    const chartUrl = `https://quickchart.io/chart?w=500&h=300&c=${encodeURIComponent(jsonStr)}`;
                    responseText = responseText.replace(chartMatch[0], "").trim();
                    payload = { image: { url: chartUrl }, caption: responseText };
                }

                const botMsg = await sock.sendMessage(jid, payload);
                tpmState[senderKey] = { step: "NGOBROL_CHAT", chatSession: chatSession, lastBotMsgId: botMsg.key.id };
            } catch (error) { await sock.sendMessage(jid, { text: "❌ Gagal menghubungi AI." }); }
            return;
        }

        // [6] MAIN FEATURE: /AM (Start Process)
        if (text.toLowerCase() === "/am") {
            tpmState[senderKey] = {
                step: "SELECT_SHEET",
                senderName: pushName,
                sheets: ["Produksi HPL", "Produksi Adhesive", "Produksi Flooring", "Produksi PVC Cikupa"]
            };
            let menu = `Halo *${pushName}*!\nPilih *Sheet Tujuan*:\n`;
            tpmState[senderKey].sheets.forEach((s, i) => menu += `${i + 1}. ${s}\n`);
            tpmState[senderKey].lastBotMsg = await sock.sendMessage(jid, { text: menu });
            return;
        }

        // [7] FALLBACK KE ORIGINAL BOT
        if (text.startsWith('/') && !tpmState[senderKey]) {
            try {
                const res = await axios.post(ORIGINAL_BOT_URL, { command: text, sender: jid });
                const data = res.data;
                const fmt = (s) => !s ? "" : String(s).replace(/<b>/g, '*').replace(/<\/b>/g, '*');
                if (data.type === 'text') await sock.sendMessage(jid, { text: fmt(data.content) });
                else if (data.type === 'photo') {
                    await sock.sendMessage(jid, { image: { url: formatImageUrl(data.url) }, caption: fmt(data.caption) });
                }
            } catch (err) { console.error("Fallback Error"); }
        }
    });
}

startSystem();
