const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
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
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("📸 SCAN QR INI DENGAN WHATSAPP KAMU:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Koneksi terputus, mencoba menyambung ulang...');
                // Biarkan index.js yang menghandle restart proses agar lebih stabil
            }
        } else if (connection === 'open') {
            console.log('✅ WHATSAPP TERHUBUNG!');
        }
    });

    // WAJIB: Mengembalikan objek agar index.js bisa membaca .ev
    return { sock, saveCreds };
}

module.exports = { connectToWhatsApp };
