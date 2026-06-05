const { connectToWhatsApp } = require('./session');
const { getContentType, downloadMediaMessage } = require("@whiskeysockets/baileys");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const { HeartbeatManager } = require('./heartbeat');
const fs = require('fs');

// 🔒 AMAN: Mengambil API Key dari file .env di server VM Anda
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const MANUAL_TPM_URL = "https://script.google.com/macros/s/AKfycbzyBY8Hdhh-2kHEh370mZetwLJGFFUTBD29ZhE8mQAu53-weofI-XU8po2NhwlyfFFI/exec";
const ORIGINAL_BOT_URL = "https://script.google.com/macros/s/AKfycbyknMRVxLOwYy_jwMaOuaQsL_a4Rjwr5eX_9lNMmO64vpoAcKxDsd_x8yQJw85te4M0/exec";
const GAS_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyt8BvIvEq34wUIF3ctJ_4E8xaxjbZ-EEPpyPK0Q155wKjSUrNz_nBVRhAG4gCU1fsY/exec"; 
const DEPT_NOTICE_NUMBER = "6285933263178@s.whatsapp.net";
const WEBHOOK_PORT = 8080;

// Master Spreadsheet Rule Book (Hanya digunakan sebagai validasi awal ketikan operator di WA)
const ITEM_RULES = {
    "30G161": /\b\d{4,5}\b/, "33G198": /\b\d{4,5}\b/, "36G161": /\b\d{4,5}\b/, "36G198": /\b\d{4,5}\b/,
    "30H160": /\b\d{14}\b/, "33F161": /\b\d{6}A\d{9}\b/, "33F198": /\b\d{6}A\d{9}\b/, "36F161": /\b\d{6}A\d{9}\b/,
    "33P160": /\b\d{6}-[A-Z0-9]+-\d-\d{2}-\d{2}\b/, "33P150": /\b\d{6}-?[A-Z0-9]?-?\d?-?\d{2,4}-?\d{0,2}\b/,
    "30R061": /\b\d{5}-[A-Z]\d\b/, "35I161": /\b(HT\d{10}|\d{9,10})\b/, "35O190": /\b\d[A-Z]\d{6}\b/
};

if (!GEMINI_API_KEY) {
    console.error("❌ ERROR: GEMINI_API_KEY tidak ditemukan di environment! Pastikan file .env sudah dibuat.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

const tpmState = {};
const app = express();
const heartbeat = new HeartbeatManager({ interval: 30000 });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock; 

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

const parseMultiSelect = (input, options) => {
    const choices = input.split(/[ ,./]+/).map(v => {
        let num = parseInt(v);
        return num === 0 ? options.length - 1 : num - 1;
    });
    const selected = choices.filter(idx => options[idx]).map(idx => options[idx]);
    return selected.length > 0 ? selected.join(", ") : null;
};

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

        // 1. Handle command /cancel
        if (text.toLowerCase() === "/cancel") {
            delete tpmState[senderKey];
            return await sock.sendMessage(jid, { text: "🚫 Proses dibatalkan." });
        }

        // 2. Handle command /am
        if (text.toLowerCase() === "/am") {
            tpmState[senderKey] = { step: "SELECT_SHEET", sheets: ["Produksi HPL", "Produksi Adhesive", "Produksi Flooring", "Produksi PVC Cikupa"] };
            let menu = `Halo *${pushName}*!\nPilih Sheet:\n` + tpmState[senderKey].sheets.map((s, i) => `${i+1}. ${s}`).join("\n");
            return await sock.sendMessage(jid, { text: menu });
        }

        // 3. Handle command /openlist
        if (text.toLowerCase() === "/openlist") {
            const res = await axios.get(`${MANUAL_TPM_URL}?action=getList`);
            let responseMsg = "📋 *DAFTAR TAG OPEN:*\n\n";
            res.data.forEach((item, i) => responseMsg += `${i + 1}. *${item.tag}* - ${item.desc}\n`);
            return await sock.sendMessage(jid, { text: responseMsg });
        }

        // 4. Handle command /open
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

        // 5. Handle command /close
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

        // 6. Handle command /input [ITEM_CODE] for OCR Flow
        if (text.toLowerCase().startsWith("/input ")) {
            const args = text.split(" ");
            const itemWip = args[1]?.trim().toUpperCase();

            if (!itemWip || !ITEM_RULES[itemWip]) {
                return await sock.sendMessage(jid, { text: "⚠️ Kode Item WIP tidak valid atau kosong. Contoh: */input 33G198*" });
            }

            tpmState[senderKey] = {
                step: "OCR_PHOTO",
                itemWip: itemWip
            };
            
            await sock.sendMessage(jid, { text: `✅ Kode Item Terbaca: *${itemWip}*\n\nSilakan kirimkan *FOTO LABEL* produk sekarang untuk dideteksi secara cerdas oleh AI.` });
            return; 
        }

        // 7. Handle command /ngobrol
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

        // 8. Handle State Management
        if (tpmState[senderKey]) {
            const current = tpmState[senderKey];

            // OCR MULTIMODAL PHOTO CAPTURE STATE (INTEGRATED WITH PATTERN-MATCHING PROMPT)
            if (current.step === "OCR_PHOTO") {
                if (messageType !== 'imageMessage') {
                    return await sock.sendMessage(jid, { text: "⚠️ Harap kirimkan foto label produk (bukan teks/dokumen)." });
                }
                await sock.sendMessage(jid, { text: "⏳ Foto diterima. Mencari dan mencocokkan kode dengan aturan master..." });
                try {
                    const buffer = await downloadMediaMessage(m, 'buffer', {});
                    const mimeType = msg.imageMessage?.mimetype || 'image/jpeg';

                    // Mengonversi aturan regex menjadi instruksi teks yang mudah dipahami oleh kecerdasan AI
                    const ruleBookText = `
                    - Untuk 30G161, 33G198, 36G161, 36G198: Harus berupa 4 sampai 5 digit angka murni (Contoh: 3015, 12345).
                    - Untuk 30H160: Harus berupa 14 digit angka murni.
                    - Untuk 33F161, 33F198, 36F161: Harus berupa 6 digit angka, diikuti huruf 'A', lalu diikuti 9 digit angka (Contoh: 123456A123456789).
                    - Untuk 33P160: Harus berupa format 6 digit angka, tanda strip, kombinasi huruf/angka, tanda strip, 1 digit angka, tanda strip, 2 digit angka, tanda strip, 2 digit angka.
                    - Untuk 33P150: Harus berupa pola format kode berawalan 6 digit angka yang dipisahkan strip opsional.
                    - Untuk 30R061: Harus berupa format 5 digit angka, tanda strip, 1 huruf besar, dan 1 digit angka (Contoh: 12345-A1).
                    - Untuk 35I161: Harus berupa kode berawalan huruf 'HT' diikuti 10 digit angka, ATAU berupa 9 sampai 10 digit angka murni (Contoh: 701364976, 2420936452).
                    - Untuk 35O190: Harus berupa 1 digit angka, 1 huruf besar, dan 6 digit angka.
                    `;

                    const aiPrompt = `Kamu adalah AI ahli verifikasi data logistik pabrik kertas.
                    Operator sedang menginput data untuk Kode Item WIP: "${current.itemWip}"
                    
                    Berikut adalah panduan pola validasi nomor lot/roll untuk item ini:
                    ${ruleBookText}
                    
                    TUGAS UTAMA:
                    1. Analisis gambar label fisik secara menyeluruh. Cari dan ekstrak SEMUA string kode, nomor seri, nomor order, nomor roll, atau nomor barcode yang tercetak di label tersebut.
                    2. Lakukan COCOK-COCOKAN (pencocokan pola) dari semua kode yang kamu temukan dengan aturan validasi khusus untuk item "${current.itemWip}" di atas.
                    3. Pilih satu kode yang PALING COCOK dan memenuhi kriteria aturan item tersebut (Utamakan nomor Barcode/Roll/Lot jika ada beberapa yang mirip).
                    4. Pastikan Kamu Mengesktrak setiap nomor yang ada satu persatu, semua kode yang ada pokoknya scan dan jajarkan satu persatu
                    Keluaran WAJIB hanya berupa kode/angka bersih hasil pilihanmu saja tanpa ada penjelasan teks, tanpa spasi panjang, tanpa kata pengantar, tanpa tanda baca, dan tanpa backtick markdown. Jika setelah dicocokkan tidak ada satu pun kode di foto yang memenuhi kriteria pola item tersebut, jawab dengan 'NOT_FOUND'.`;

                    const aiResponse = await aiModel.generateContent([
                        {
                            inlineData: {
                                data: buffer.toString('base64'),
                                mimeType: mimeType
                            }
                        },
                        aiPrompt
                    ]);

                    const extractedLot = aiResponse.response.text().trim().replace(/`/g, "");

                    if (extractedLot === "NOT_FOUND") {
                        await sock.sendMessage(jid, { text: `❌ AI tidak dapat menemukan nomor lot/reel yang sesuai dengan spesifikasi aturan pola untuk item *${current.itemWip}*.` });
                        delete tpmState[senderKey];
                        return;
                    }

                    // Kirim hasil akhir bersih hasil cocok-cocokan AI ke Google Sheets
                    const response = await fetch(GAS_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            itemWip: current.itemWip,
                            ocrText: extractedLot, 
                            sender: senderKey.split(/[:@]/)[0]
                        })
                    });

                    const responseText = await response.text();
                    let resData;
                    try {
                        resData = JSON.parse(responseText);
                    } catch (jsonErr) {
                        console.error("[GAS ERROR RESPONSE]:", responseText);
                        throw new Error("Google Apps Script melempar halaman HTML.");
                    }

                    if (resData.success) {
                        await sock.sendMessage(jid, { 
                            text: `✅ *Logged to Sheet!*\n\n*Item:* ${current.itemWip}\n*Lot:* \`${resData.lot}\`` 
                        });
                    } else {
                        await sock.sendMessage(jid, { 
                            text: `❌ AI berhasil mencocokkan nomor \`${extractedLot}\`, tetapi ditolak oleh sistem validasi akhir Google Sheets.` 
                        });
                    }
                } catch (error) {
                    console.error("Multimodal Rule-Matching AI Error:", error.message);
                    await sock.sendMessage(jid, { text: "🚨 Bridge Error: Gagal menganalisis foto menggunakan kecerdasan visual AI." });
                }
                delete tpmState[senderKey];
                return; 
            }

            if (current.step === "NGOBROL_CHAT") {
                const result = await current.chatSession.sendMessage(text);
                return await sock.sendMessage(jid, { text: result.response.text() + "\n\n_(Balas untuk lanjut)_" });
            }

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

            return;
        }

        // Fallback for external macro links
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
