
require('dotenv').config();

const { Address } = require('@ton/core');
const { TonClient } = require('@ton/ton');

async function main() {
    try {
        const address = process.env.PUBLIC_WALLET_ADDRESS;

        if (!address) {
            throw new Error('PUBLIC_WALLET_ADDRESS eksik.');
        }

        const wallet = Address.parse(address);

        const client = new TonClient({
            endpoint: process.env.TONCENTER_ENDPOINT ||
                'https://toncenter.com/api/v2/jsonRPC',
            apiKey: process.env.TONCENTER_API_KEY || undefined
        });

        console.log('Cüzdan:', wallet.toString());

        const balance = await client.getBalance(wallet);
        console.log('Yerel TON bakiyesi:', Number(balance) / 1e9);

        console.log('Salt okunur test tamamlandı.');

    } catch (error) {
        console.error('Kontrol hatası:', error.message);
        process.exitCode = 1;
    }
}

main();
