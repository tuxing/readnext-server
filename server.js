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

                // CONTENT HEALING: Fetch existing articles to check for incomplete content
                const incomingIds = changes.map(item => item.id);
                const existingDocs = await Article.find({
                    namespace: namespace,
                    id: { $in: incomingIds }
                }).lean();

                // Build lookup map for quick access
                const existingMap = {};
                existingDocs.forEach(doc => {
                    existingMap[doc.id] = doc;
                });

                const CONTENT_THRESHOLD = 200; // Characters - less than this is "incomplete"
                let healedCount = 0;

                // Process changes with content healing logic
                const bulkOps = changes.map(item => {
                    const existing = existingMap[item.id];
                    const existingContent = existing?.data?.content || "";
                    const incomingContent = item.content || "";

                    const serverIncomplete = existingContent.length < CONTENT_THRESHOLD;
                    const clientComplete = incomingContent.length >= CONTENT_THRESHOLD;

                    let finalUpdatedAt = item.updatedAt || Date.now();

                    // HEAL: If server has incomplete content and client has complete content,
                    // accept client's version regardless of timestamp
                    if (existing && serverIncomplete && clientComplete) {
                        console.log(`[${namespace}] Content healing: ${item.id} (Server: ${existingContent.length} chars -> Client: ${incomingContent.length} chars)`);
                        finalUpdatedAt = Date.now(); // Update timestamp to propagate to other clients
                        healedCount++;
                    }

                    return {
                        updateOne: {
                            filter: { namespace: namespace, id: item.id },
                            update: {
                                $set: {
                                    updatedAt: finalUpdatedAt,
                                    data: item
                                }
                            },
                            upsert: true
                        }
                    };
                });

                if (bulkOps.length > 0) {
                    console.time(`[${namespace}] MongoWrite`);
                    const result = await Article.bulkWrite(bulkOps, { ordered: false });
                    console.timeEnd(`[${namespace}] MongoWrite`);
                    console.log(`[${namespace}] BulkWrite Result: Matched ${result.matchedCount}, Modified ${result.modifiedCount}, Upserted ${result.upsertedCount}${healedCount > 0 ? `, Healed ${healedCount}` : ''}`);
                }
            }
        } else {
            // Local File Path
            // Ensure namespace exists
            if (!db[namespace]) db[namespace] = [];
            const collection = db[namespace];
            const CONTENT_THRESHOLD = 200;
            let healedCount = 0;

            changes.forEach(clientItem => {
                const idx = collection.findIndex(a => a.id === clientItem.id);
                if (idx === -1) {
                    collection.push(clientItem);
                } else {
                    // CONTENT HEALING: Check if existing is incomplete
                    const existingContent = collection[idx].content || "";
                    const incomingContent = clientItem.content || "";

                    if (existingContent.length < CONTENT_THRESHOLD && incomingContent.length >= CONTENT_THRESHOLD) {
                        console.log(`[${namespace}] Content healing: ${clientItem.id} (Server: ${existingContent.length} chars -> Client: ${incomingContent.length} chars)`);
                        clientItem.updatedAt = Date.now();
                        healedCount++;
                    }
                    collection[idx] = clientItem;
                }
            });
            if (changes.length > 0) {
                if (healedCount > 0) console.log(`[${namespace}] Healed ${healedCount} articles`);
                saveDB();
            }
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

// --- SINGLE ARTICLE FETCH ---
// GET /api/article/:namespace/:id - Fetch a single article by ID
app.get('/api/article/:namespace/:id', validateApiPin, async (req, res) => {
    try {
        const { namespace, id } = req.params;
        console.log(`[${namespace}] Single Article Fetch: ${id}`);

        let article = null;

        if (USE_MONGO) {
            const doc = await Article.findOne({ namespace: namespace, id: id });
            if (doc) {
                article = doc.data;
            }
        } else {
            // Local File Path
            if (db[namespace]) {
                article = db[namespace].find(a => a.id === id);
            }
        }

        if (article) {
            console.log(`[${namespace}] Found article: ${article.title || 'Untitled'}`);
            res.json({ success: true, article: article });
        } else {
            console.log(`[${namespace}] Article not found: ${id}`);
            res.status(404).json({ success: false, error: 'Article not found' });
        }
    } catch (e) {
        console.error("Article Fetch Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- STATS ENDPOINT ---
// GET /api/stats/:namespace - Get article statistics including incomplete count
app.get('/api/stats/:namespace', validateApiPin, async (req, res) => {
    try {
        const { namespace } = req.params;
        const CONTENT_THRESHOLD = 200;

        let total = 0;
        let incomplete = 0;
        let incompleteArticles = [];

        if (USE_MONGO) {
            total = await Article.countDocuments({ namespace });

            // Find incomplete articles (content < 200 chars)
            const docs = await Article.find({ namespace }).lean();
            docs.forEach(doc => {
                const content = doc.data?.content || "";
                if (content.length < CONTENT_THRESHOLD) {
                    incomplete++;
                    incompleteArticles.push({
                        id: doc.id,
                        title: doc.data?.title || 'Untitled',
                        contentLength: content.length
                    });
                }
            });
        } else {
            if (db[namespace]) {
                total = db[namespace].length;
                db[namespace].forEach(article => {
                    const content = article.content || "";
                    if (content.length < CONTENT_THRESHOLD) {
                        incomplete++;
                        incompleteArticles.push({
                            id: article.id,
                            title: article.title || 'Untitled',
                            contentLength: content.length
                        });
                    }
                });
            }
        }

        console.log(`[${namespace}] Stats: ${total} total, ${incomplete} incomplete`);

        res.json({
            namespace,
            total,
            incomplete,
            incompleteArticles: incompleteArticles.slice(0, 20) // Limit to 20 for readability
        });
    } catch (e) {
        console.error("Stats Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Hello
app.get('/', (req, res) => res.send('ReadNext Local Sync Server Running.'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReadNext Server v1.3.1 running on http://0.0.0.0:${PORT}`);
    console.log(`Sync Endpoint: http://0.0.0.0:${PORT}/api/sync/:namespace`);
});
