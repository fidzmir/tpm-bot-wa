const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require('qrcode-terminal');

async function connectToWhatsApp() {
    // Menggunakan nama folder yang konsisten dengan .gitignore
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: ["TPM System", "Chrome", "1.0.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { qr } = update;
        
        if (qr) {
            console.log("📸 SCAN QR INI DENGAN WHATSAPP KAMU:");
            qrcode.generate(qr, { small: true });
        }
    });

    // WAJIB: Mengembalikan objek agar index.js bisa membaca .ev
    return { sock, saveCreds };
}

module.exports = { connectToWhatsApp };
