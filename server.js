const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'db.json');

app.use((req, res, next) => {
    console.log(`[DEBUG] Incoming ${req.method} ${req.url} - Length: ${req.get('Content-Length')}`);
    console.log(`[DEBUG] Incoming ${req.method} ${req.url} - Length: ${req.get('Content-Length')}`);
    next();
});

// MongoDB Setup
const mongoose = require('mongoose');
const MONGODB_URI = process.env.MONGODB_URI;
let USE_MONGO = false;

const ArticleSchema = new mongoose.Schema({
    id: { type: String, required: true, index: true },
    namespace: { type: String, required: true, index: true },
    updatedAt: { type: Number, default: 0 },
    data: { type: Object } // Store the entire article object here
}, { strict: false });

// Compound index for uniqueness within namespace
ArticleSchema.index({ namespace: 1, id: 1 }, { unique: true });

// INDEX FOR SYNC SPEED (Pull Query)
// Speeds up: find({ namespace, updatedAt: {$gt} }).sort({ updatedAt: 1 })
ArticleSchema.index({ namespace: 1, updatedAt: 1 });

const Article = mongoose.model('Article', ArticleSchema);

if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => {
            console.log("Connected to MongoDB Atlas");
            USE_MONGO = true;
        })
        .catch(err => console.error("MongoDB Connection Error:", err));
} else {
    console.log("No MONGODB_URI found. Using Local File Storage (db.json).");
}

// MANUALLY Handle OPTIONS for Preflight issues
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
    res.sendStatus(200);
});

app.use(cors());

// Use built-in Express body parsing (Express 4.16+)
// Using '50mb' is standard, but we'll go huge for this user
app.use(express.json({ limit: '1024mb' }));
app.use(express.urlencoded({ limit: '1024mb', extended: true, parameterLimit: 1000000 }));

// Load DB
let db = { articles: [] };
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Failed to load DB, starting fresh.");
    }
}

// Save DB Helper
const saveDB = () => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
};

// --- AUTH MIDDLEWARE ---
const SERVER_PIN = process.env.SERVER_PIN;

const validateApiPin = (req, res, next) => {
    // If no pin is set on server, allow all
    if (!SERVER_PIN) return next();

    const clientPin = req.headers['x-auth-pin'];

    // Strict check
    if (clientPin === SERVER_PIN) {
        return next();
    }

    console.log(`[AUTH] Blocked request from ${req.ip} - Invalid/Missing PIN`);
    return res.status(401).json({ error: 'Unauthorized: Invalid Server PIN' });
};

// Sync Endpoint (Generic)
app.post('/api/sync/:namespace', validateApiPin, async (req, res) => {
    try {
        const { namespace } = req.params;
        const { changes = [], lastSync = 0 } = req.body;

        console.log(`[${namespace}] Sync Req: ${changes.length} changes, LastSync: ${lastSync}`);

        // 1. Process Incoming Changes (Push) WITH HYBRID LOGIC
        if (USE_MONGO) {
            // MongoDB Path
            if (changes && changes.length > 0) {
                console.log(`[readnext] Sync Req: ${changes.length} changes, LastSync: ${lastSync}`);

                // OPTIMIZATION: Use unordered bulk write for speed (don't wait for previous to finish)
                // and process the mapping in parallel
                const bulkOps = changes.map(item => ({
                    updateOne: {
                        filter: { namespace: namespace, id: item.id }, // Keep namespace in filter for uniqueness
                        update: {
                            $set: {
                                updatedAt: item.updatedAt || Date.now(),
                                data: item // Store the entire item in the 'data' field
                            }
                        },
                        upsert: true
                    }
                }));

                if (bulkOps.length > 0) {
                    console.time(`[${namespace}] MongoWrite`);
                    // RESTORED parallel write (ordered: false).
                    // verification: The previous "Hang" was likely the Pull OOM, not this.
                    const result = await Article.bulkWrite(bulkOps, { ordered: false });
                    console.timeEnd(`[${namespace}] MongoWrite`);
                    console.log(`[${namespace}] BulkWrite Result: Matched ${result.matchedCount}, Modified ${result.modifiedCount}, Upserted ${result.upsertedCount}`);
                }
            }
        } else {
            // Local File Path
            // Ensure namespace exists
            if (!db[namespace]) db[namespace] = [];
            const collection = db[namespace];

            changes.forEach(clientItem => {
                const idx = collection.findIndex(a => a.id === clientItem.id);
                if (idx === -1) collection.push(clientItem);
                else collection[idx] = clientItem;
            });
            if (changes.length > 0) saveDB();
        }

        // 2. Identify Outgoing Changes (Pull)
        let updatesForClient = [];
        let limit = 50; // Default safe limit
        if (req.body.limit && !isNaN(req.body.limit)) {
            limit = parseInt(req.body.limit);
            if (limit > 50) limit = 50; // Hard Cap
        }
        if (limit <= 0) limit = 50; // Safety

        const page = parseInt(req.body.page) || 0;
        const skip = page * limit;
        let hasMore = false;
        let totalUpdates = 0;

        if (USE_MONGO) {
            console.time(`[${namespace}] MongoRead`);
            // Fetch only requested page + 1 to check hasMore
            // Sort by updatedAt is CRITICAL for stable paging
            const docs = await Article.find({
                namespace: namespace,
                updatedAt: { $gte: lastSync }  // Changed from $gt to $gte to not miss same-timestamp items
            })
                .sort({ updatedAt: 1, _id: 1 })  // Secondary sort by _id for stable ordering
                .skip(skip)
                .limit(limit + 1); // Fetch one extra to detect hasMore

            console.timeEnd(`[${namespace}] MongoRead`);

            if (docs.length > limit) {
                hasMore = true;
                docs.pop(); // Remove the extra check item
            }

            updatesForClient = docs.map(d => d.data);

            // Optional: Count total (slow, maybe skip?)
            // totalUpdates = await Article.countDocuments({ namespace: namespace, updatedAt: { $gt: lastSync } });
            totalUpdates = 9999; // Dummy, client doesn't strictly need exact total
        } else {
            // Local File Path (Keep existing logic but apply limit)
            if (db[namespace]) {
                let all = db[namespace].filter(a => (a.updatedAt || 0) >= lastSync);  // Changed from > to >=
                all.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

                totalUpdates = all.length;
                hasMore = (skip + limit) < totalUpdates;
                updatesForClient = all.slice(skip, skip + limit);
            }
        }

        console.log(`[${namespace}] Pull: Sending page ${page} (limit ${limit}, count ${updatesForClient.length}). HasMore: ${hasMore}`);

        res.json({
            changes: updatesForClient,
            serverTime: Date.now(),
            hasMore: hasMore,
            totalUpdates: totalUpdates
        });

    } catch (e) {
        console.error("Sync Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Hello
app.get('/', (req, res) => res.send('ReadNext Local Sync Server Running.'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReadNext Server v1.1.3 running on http://0.0.0.0:${PORT}`);
    console.log(`Sync Endpoint: http://0.0.0.0:${PORT}/api/sync/:namespace`);
});
