const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
    SECRET: process.env.TOPUP_SECRET || "7x143414",
    TOPUP_AMOUNT: process.env.TOPUP_AMOUNT || "0.0000906",
    RPC_URL: process.env.RPC_URL || "https://bsc-dataseed1.binance.org/",
    DATA_FILE: path.join(__dirname, 'topup_data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    topups: [],
    addresses: {}
};

if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        dataStore = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        console.log('✅ Data loaded');
    } catch (err) {
        console.error('Error loading data:', err);
    }
}

function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(dataStore, null, 2));
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

// ============ POST /topup ============
app.post('/topup', async (req, res) => {
    console.log('\n📨 POST /topup received');
    console.log('   Body:', req.body);
    console.log('   Has secret header:', !!req.headers['x-topup-secret']);
    
    try {
        const { to } = req.body;
        const secret = req.headers['x-topup-secret'];
        
        // Validation
        if (!secret || secret !== CONFIG.SECRET) {
            console.log('❌ Invalid secret');
            return res.status(401).json({ ok: false, error: 'Invalid secret' });
        }
        
        if (!to || !ethers.isAddress(to)) {
            console.log('❌ Invalid address');
            return res.status(400).json({ ok: false, error: 'Invalid address' });
        }
        
        if (!process.env.FUNDING_PRIVATE_KEY) {
            console.log('❌ FUNDING_PRIVATE_KEY not set');
            return res.status(500).json({ ok: false, error: 'Funding wallet not configured' });
        }
        
        const normalizedAddress = to.toLowerCase();
        console.log('✅ Sending', CONFIG.TOPUP_AMOUNT, 'BNB to', normalizedAddress);
        
        // Setup
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const fundingWallet = new ethers.Wallet(process.env.FUNDING_PRIVATE_KEY, provider);
        
        console.log('💰 Funding wallet:', fundingWallet.address);
        
        const topupAmountWei = ethers.parseEther(CONFIG.TOPUP_AMOUNT);
        
        // Check balance
        const fundingBalance = await provider.getBalance(fundingWallet.address);
        const fundingBalanceBNB = parseFloat(ethers.formatEther(fundingBalance));
        
        console.log('   Funding balance:', fundingBalanceBNB, 'BNB');
        
        // Calculate total needed
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
        const estimatedGasCost = gasPrice * 100000n;
        const totalNeeded = topupAmountWei + estimatedGasCost;
        
        if (fundingBalance < totalNeeded) {
            console.log('❌ Insufficient BNB');
            console.log('   Required:', ethers.formatEther(totalNeeded));
            console.log('   Available:', fundingBalanceBNB);
            
            return res.status(500).json({
                ok: false,
                error: 'Insufficient BNB in funding wallet',
                required: ethers.formatEther(totalNeeded),
                available: fundingBalanceBNB
            });
        }
        
        // Send transaction
        console.log('💸 Sending transaction...');
        
        const tx = await fundingWallet.sendTransaction({
            to: normalizedAddress,
            value: topupAmountWei,
            gasLimit: 100000,
            gasPrice: gasPrice
        });
        
        console.log('📤 Tx sent:', tx.hash);
        
        // Wait for confirmation
        const receipt = await tx.wait(1);
        
        if (receipt.status === 0) {
            console.log('❌ Transaction reverted');
            return res.status(500).json({ ok: false, error: 'Transaction reverted' });
        }
        
        console.log('✅ Confirmed! Block:', receipt.blockNumber);
        console.log('   Gas used:', receipt.gasUsed.toString());
        
        // Save record
        const topupRecord = {
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            to: normalizedAddress,
            amount: CONFIG.TOPUP_AMOUNT,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            timestamp: new Date().toISOString()
        };
        
        dataStore.topups.push(topupRecord);
        
        if (!dataStore.addresses[normalizedAddress]) {
            dataStore.addresses[normalizedAddress] = {
                totalTopups: 0,
                totalAmountBNB: 0,
                firstTopup: new Date().toISOString()
            };
        }
        
        dataStore.addresses[normalizedAddress].totalTopups++;
        dataStore.addresses[normalizedAddress].totalAmountBNB += parseFloat(CONFIG.TOPUP_AMOUNT);
        dataStore.addresses[normalizedAddress].lastTopup = new Date().toISOString();
        
        if (dataStore.topups.length > 1000) {
            dataStore.topups = dataStore.topups.slice(-1000);
        }
        
        saveData();
        
        res.json({
            ok: true,
            txHash: tx.hash,
            amount: CONFIG.TOPUP_AMOUNT,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        
        // Handle specific errors
        if (error.message.includes('insufficient funds')) {
            return res.status(500).json({
                ok: false,
                error: 'Insufficient BNB for gas + value'
            });
        }
        
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// ============ GET /health ============
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        fundingConfigured: !!process.env.FUNDING_PRIVATE_KEY,
        topupAmount: CONFIG.TOPUP_AMOUNT,
        totalTopups: dataStore.topups.length
    });
});

// ============ GET / ============
app.get('/', (req, res) => {
    res.json({
        service: 'BNB Top-Up API',
        version: '4.0.0',
        endpoint: 'POST /topup',
        requiredHeaders: {
            'Content-Type': 'application/json',
            'x-topup-secret': CONFIG.SECRET.substring(0, 3) + '...'
        },
        bodyFormat: { to: '0x...' },
        status: {
            fundingConfigured: !!process.env.FUNDING_PRIVATE_KEY,
            healthy: true
        }
    });
});

// ============ GET /stats ============
app.get('/stats', (req, res) => {
    const totalBNB = dataStore.topups.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    res.json({
        totalTopups: dataStore.topups.length,
        totalBNBSent: totalBNB.toFixed(6),
        uniqueAddresses: Object.keys(dataStore.addresses).length
    });
});

// ============ START ============
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     🚀 BNB Top-Up API v4.0                        ║
╠══════════════════════════════════════════════════╣
║  Port: ${PORT}                                      ║
║  Amount: ${CONFIG.TOPUP_AMOUNT} BNB                          ║
║  Funding: ${process.env.FUNDING_PRIVATE_KEY ? '✅ YES' : '❌ NO'}                           ║
║                                                  ║
║  POST /topup   - Send BNB                        ║
║  GET  /health  - Status                          ║
║  GET  /stats   - Statistics                      ║
╚══════════════════════════════════════════════════╝
    `);
});
