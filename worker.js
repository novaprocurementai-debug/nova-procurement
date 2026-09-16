const MODEL="@cf/meta/llama-3.1-8b-instruct-fast";
const TARGET_NETWORK=20000000;
const REGIONS=[["US","North America"],["CA","North America"],["CN","China"],["IN","India"],["JP","Japan"],["KR","South Korea"],["DE","Europe"],["GB","Europe"],["FR","Europe"],["IT","Europe"]];

function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json;charset=UTF-8",...headers}})}
function cookieValue(req,name){const c=req.headers.get("Cookie")||"";const m=c.match(new RegExp("(^|;\\s*)"+name+"=([^;]*)"));return m?decodeURIComponent(m[2]):null}
function token(){return crypto.randomUUID()+crypto.randomUUID()}
async function sha256(t){const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t));return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function passwordHash(p,s){return sha256(s+":"+p)}
function sessionCookie(t){return `nova_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`}
function clearCookie(){return "nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"}

async function ensureDB(db){
const tables=[
`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,url TEXT UNIQUE,country TEXT,region TEXT,source TEXT,product TEXT,price REAL,currency TEXT,moq REAL,lead_time TEXT,shipping TEXT,incoterm TEXT,certifications TEXT,oem_odm TEXT,evidence INTEGER DEFAULT 0,confidence INTEGER DEFAULT 0,deal_score INTEGER DEFAULT 0,verified INTEGER DEFAULT 0,verification TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,name TEXT,product TEXT,quantity REAL,destination TEXT,status TEXT DEFAULT 'active',created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS rfqs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,product TEXT,quantity REAL,destination TEXT,requirements TEXT,message TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS bids(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,rfq_id INTEGER,supplier TEXT,supplier_url TEXT,unit_price REAL,currency TEXT,moq REAL,lead_time TEXT,shipping REAL,incoterm TEXT,payment_terms TEXT,notes TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS negotiations(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,supplier TEXT,offer TEXT,result TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS purchase_orders(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,bid_id INTEGER,supplier TEXT,product TEXT,quantity REAL,unit_price REAL,total REAL,currency TEXT DEFAULT 'USD',status TEXT DEFAULT 'draft',created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,product TEXT,supplier TEXT,quantity REAL,unit_price REAL,shipping REAL,landed_cost REAL,supplier_url TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS flash_deals(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,company TEXT,product TEXT,description TEXT,country TEXT,quantity REAL,price REAL,currency TEXT DEFAULT 'USD',moq REAL,expires_at TEXT,status TEXT DEFAULT 'submitted',url TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS procurement_memory(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,supplier TEXT,product TEXT,note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`
];

for(const sql of tables){try{await db.prepare(sql).run()}catch{}}

const migrations={
suppliers:[["price","REAL"],["currency","TEXT"],["moq","REAL"],["lead_time","TEXT"],["shipping","TEXT"],["incoterm","TEXT"],["certifications","TEXT"],["oem_odm","TEXT"],["confidence","INTEGER DEFAULT 0"],["verified","INTEGER DEFAULT 0"],["verification","TEXT"]],
flash_deals:[["expires_at","TEXT"]],
bids:[["supplier_url","TEXT"],["unit_price","REAL"],["currency","TEXT"],["moq","REAL"],["lead_time","TEXT"],["shipping","REAL"],["incoterm","TEXT"],["payment_terms","TEXT"],["notes","TEXT"]]
};

for(const [table,cols] of Object.entries(migrations)){
let existing=new Set();
try{
const info=await db.prepare(`PRAGMA table_info(${table})`).all();
existing=new Set((info.results||[]).map(x=>x.name))
}catch{}
for(const [name,type] of cols){
if(!existing.has(name)){
try{await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run()}catch{}
}
}
}
}

async function currentUser(req,db){
if(!db)return null;
const t=cookieValue(req,"nova_session");
if(!t)return null;
return db.prepare(`SELECT users.id,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires_at>?`).bind(t,Date.now()).first()
}

function cleanText(t){
return String(t||"").replace(/\s+/g," ").trim().slice(0,50000)
}

function num(v){
const n=Number(String(v).replace(/,/g,""));
return Number.isFinite(n)?n:null
}

/* =========================
   IMPROVED EXTRACTION
========================= */

function parsePrice(t){
const s=cleanText(t);

const patterns=[
/(?:unit\s+price|price|starting\s+price|from)\s*(?:is|:|=|from|starting\s+from)?\s*(?:US\$|USD|\$)\s*([\d,]+(?:\.\d+)?)/i,
/(?:US\$|USD|\$)\s*([\d,]+(?:\.\d+)?)(?:\s*(?:-|to)\s*(?:US\$|USD|\$)?\s*[\d,]+(?:\.\d+)?)?\s*(?:per|\/)?\s*(?:piece|pc|pcs|unit)?/i,
/([\d,]+(?:\.\d+)?)\s*(?:USD|US\$)\s*(?:per|\/)?\s*(?:piece|pc|pcs|unit)?/i
];

for(const re of patterns){
const m=s.match(re);
if(!m)continue;
const n=num(m[1]);
if(n!==null&&n>0&&n<100000)return n;
}

return null
}

function parseMOQ(t){
const s=cleanText(t);

const patterns=[
/\bMOQ\s*(?:is|:|=|-|from|starting\s+from)?\s*([\d,]+(?:\.\d+)?)\s*(?:pcs?|pieces?|units?|sets?)?/i,
/\bminimum\s+order\s+(?:quantity|qty)?\s*(?:is|:|=|-|from|starting\s+from)?\s*([\d,]+(?:\.\d+)?)/i,
/\bminimum\s+order\s*(?:is|:|=|-|from|starting\s+from)?\s*([\d,]+(?:\.\d+)?)/i,
/\bmin(?:imum)?\s+order\s*(?:is|:|=|-|from|starting\s+from)?\s*([\d,]+(?:\.\d+)?)/i
];

for(const re of patterns){
const m=s.match(re);
if(m){
const n=num(m[1]);
if(n!==null&&n>0)return n;
}
}

return null
}

function parseLead(t){
const s=cleanText(t);

const patterns=[
/lead\s*time\s*(?:is|:|=|-)?\s*(\d+(?:\s*-\s*\d+)?\s*-?\s*(?:days?|weeks?|months?))/i,
/production\s*time\s*(?:is|:|=|-)?\s*(\d+(?:\s*-\s*\d+)?\s*-?\s*(?:days?|weeks?|months?))/i,
/(\d+(?:\s*-\
