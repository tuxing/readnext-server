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

// Sync Endpoint (Generic)
app.post('/api/sync/:namespace', async (req, res) => {
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
                    // ordered: false is faster (parallel on mongo side)
                    await Article.bulkWrite(bulkOps, { ordered: false });
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

        if (USE_MONGO) {
            // Fetch from Mongo
            const docs = await Article.find({
                namespace: namespace,
                updatedAt: { $gt: lastSync }
            }).limit(500); // Safety limit for query, pagination handled by logic?
            // Actually our pagination logic expects all candidates then slices. 
            // For massive DBs this is bad, but for readnext it's fine.
            // Let's rely on standard find for now.
            // Mongoose returns docs. map to data.
            updatesForClient = docs.map(d => d.data);
        } else {
            // Local File Path
            if (db[namespace]) {
                updatesForClient = db[namespace].filter(a => (a.updatedAt || 0) > lastSync);
            }
        }



        // Sort by updatedAt ASC to ensure consistent paging if we were using cursor, 
        // but for 'page' offset, any deterministic sort is fine.
        updatesForClient.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

        // Pagination Logic
        let limit = 50000; // Default
        if (req.body.limit !== undefined && req.body.limit !== null) {
            limit = parseInt(req.body.limit);
        }

        const page = req.body.page || 0;

        const totalUpdates = updatesForClient.length;
        const startIndex = page * limit;
        const slicedUpdates = updatesForClient.slice(startIndex, startIndex + limit);
        const hasMore = (startIndex + limit) < totalUpdates;

        console.log(`[${namespace}] Pull: Found ${totalUpdates} updates. Sending page ${page} (limit ${limit}, count ${slicedUpdates.length}). HasMore: ${hasMore}`);

        res.json({
            changes: slicedUpdates,
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
    console.log(`ReadNext Server v1.1.2 running on http://0.0.0.0:${PORT}`);
    console.log(`Sync Endpoint: http://0.0.0.0:${PORT}/api/sync/:namespace`);
});
