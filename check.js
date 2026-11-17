
require('dotenv').config();

const { TonClient, WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

async function main() {
    try {
        console.log('🔍 Yerel TON kontrolü başlıyor...');

        const mnemonic = (process.env.WALLET_MNEMONIC || '')
            .trim()
            .split(/\s+/);

        if (mnemonic.length < 12) {
            throw new Error('WALLET_MNEMONIC eksik veya geçersiz.');
        }

        const keyPair = await mnemonicToPrivateKey(mnemonic);

        const wallet = WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey
        });

        const client = new TonClient({
            endpoint: process.env.TONCENTER_ENDPOINT ||
                'https://toncenter.com/api/v2/jsonRPC',
            apiKey: process.env.TONCENTER_API_KEY || undefined
        });

        console.log('Cüzdan:', wallet.address.toString());

        const balance = await client.getBalance(wallet.address);
        const tonBalance = Number(balance) / 1e9;

        console.log('✅ Yerel TON bakiyesi:', tonBalance, 'TON');
        console.log('✅ Salt okunur kontrol tamamlandı.');

    } catch (error) {
        console.error('❌ Kontrol hatası:', error.message);
        process.exitCode = 1;
    }
}

main();
