const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require('qrcode-terminal'); // Tambahkan ini

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        // printQRInTerminal: true, // Hapus atau abaikan ini karena sudah deprecated
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: ["TPM System", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // --- LOGIKA BARU UNTUK RENDER QR ---
        if (qr) {
            console.log("📸 SCAN QR INI DENGAN WHATSAPP KAMU:");
            qrcode.generate(qr, { small: true }); // Ini yang bakal nampilin kode QR-nya
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Koneksi terputus, mencoba menyambung ulang...');
                connectToWhatsApp();
            } else {
                console.log('❌ Sesi Keluar. Hapus folder auth_info dan scan ulang!');
            }
        } else if (connection === 'open') {
            console.log('✅ WHATSAPP TERHUBUNG!');
        }
    });

    return sock;
}

module.exports = { connectToWhatsApp };