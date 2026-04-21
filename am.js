const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const axios = require("axios");

// Your Apps Script URL
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyknMRVxLOwYy_jwMaOuaQsL_a4Rjwr5eX_9lNMmO64vpoAcKxDsd_x8yQJw85te4M0/exec";

async function startManualBot() {
    // 1. Use the SAME auth folder as your other script
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Hides all the JSON wall of text
        printQRInTerminal: false,
        browser: ["Mac OS", "Chrome", "14.4.1"]
    });

    const userState = {};

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('✅ MANUAL TPM BOT IS READY');
            console.log('Use /AM to start the process.');
        }
        // If it closes due to conflict (440), we let it restart or wait
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        // --- THE FLOW ---
        
        // Start Command
       if (text.toLowerCase() === "/am" || text.toLowerCase() === "am")  {
            userState[jid] = { step: "MACHINE" };
            return sock.sendMessage(jid, { text: "📝 *MANUAL RED TAG*\nKetik *Nama Mesin*:" });
        }

        const current = userState[jid];
        if (!current) return;

        // Step 1: Get Machine -> Send Abnormality Poll
        if (current.step === "MACHINE") {
            current.machine = text;
            current.step = "POLL_1";
            return sock.sendMessage(jid, {
                poll: {
                    name: "⚠️ *Pilih Abnormality:*",
                    values: ["Bocor", "Rusak", "Kendur", "Cacat", "Suhu Berlebih", "Lain-Lain"],
                    selectableCount: 1
                }
            });
        }

        // Step 2: Handle Poll & Ask for Photo
        if (m.message.pollUpdateMessage && current.step === "POLL_1") {
            current.step = "PHOTO";
            return sock.sendMessage(jid, { text: "📸 Kirim *Foto Bukti* untuk menyelesaikan:" });
        }

        // Step 3: Get Photo & Upload
        if (m.message.imageMessage && current.step === "PHOTO") {
            await sock.sendMessage(jid, { text: "⏳ _Menyimpan ke Spreadsheet..._" });
            
            try {
                await axios.post(APPS_SCRIPT_URL, {
                    machine: current.machine,
                    type: "MANUAL_ENTRY"
                });
                await sock.sendMessage(jid, { text: "✅ *Berhasil Disimpan!*" });
            } catch (e) {
                await sock.sendMessage(jid, { text: "❌ Gagal koneksi ke Spreadsheet." });
            }
            delete userState[jid]; // Clear state
        }
    });
}

startManualBot();