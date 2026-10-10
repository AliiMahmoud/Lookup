// Fills the Docker test databases (docker-compose.yml here) with the same sample data in every engine:
// shop (10 tables), hr (5) and analytics (3), about 390,000 rows per engine; Redis gets about 100,000 keys.
// Usage: node test/docker/seed.js [oracle postgres mysql clickhouse redis mongodb] [--force] [--check]
//   --force  load again even when the data is already there      --check  only print the row counts
// Outside Docker (Node 18+, or: ELECTRON_RUN_AS_NODE=1 npx electron test/docker/seed.js) it uses 127.0.0.1.
process.env.TZ = 'UTC';
const env = process.env;
const PW = 'lookup';
const T = {
  oracle: { host: env.ORACLE_HOST || '127.0.0.1', port: Number(env.ORACLE_PORT || 1522) },
  postgres: { host: env.PG_HOST || '127.0.0.1', port: Number(env.PG_PORT || 5432) },
  mysql: { host: env.MYSQL_HOST || '127.0.0.1', port: Number(env.MYSQL_PORT || 3306) },
  clickhouse: { host: env.CH_HOST || '127.0.0.1', port: Number(env.CH_PORT || 8123) },
  redis: { host: env.REDIS_HOST || '127.0.0.1', port: Number(env.REDIS_PORT || 6379) },
  mongodb: { host: env.MONGO_HOST || '127.0.0.1', port: Number(env.MONGO_PORT || 27017) },
};
// Oracle: schemas SHOP and HR live in FREEPDB1, schema ANALYTICS in the second PDB.
const ORACLE_PDB = { shop: 'FREEPDB1', hr: 'FREEPDB1', analytics: 'ANALYTICSPDB' };

// ---------- tables (one description, turned into each engine's types below) ----------
// type[(args)][?] [pk] [unique] [ref=table]   ? = may be empty
const SCHEMA = {
  shop: {
    countries: { code: 'char(2) pk', name: 'str(60)', continent: 'enum(Africa|Asia|Europe|North America|South America|Oceania)', currency: 'char(3)', phone_prefix: 'str(6)', population: 'bigint', eu_member: 'bool' },
    categories: { id: 'id', name: 'str(60)', parent_id: 'int? ref=categories', slug: 'str(80) unique', description: 'str(200)?', sort_order: 'int' },
    suppliers: { id: 'id', name: 'str(100)', contact_name: 'str(80)', email: 'str(120)', phone: 'str(30)?', country_code: 'char(2) ref=countries', rating: 'dec(2,1)', active: 'bool', website: 'str(120)?', created_at: 'ts' },
    products: { id: 'id', sku: 'str(20) unique', name: 'str(120)', category_id: 'int ref=categories', supplier_id: 'int ref=suppliers', price: 'dec(10,2)', cost: 'dec(10,2)', stock: 'int', weight_kg: 'dec(8,3)?', tags: 'tags', attributes: 'json', discontinued: 'bool', released_date: 'date', description: 'text?', created_at: 'ts' },
    customers: { id: 'id', first_name: 'str(60)', last_name: 'str(60)', email: 'str(120) unique', phone: 'str(30)?', country_code: 'char(2) ref=countries', birth_date: 'date?', gender: 'enum(F|M)?', loyalty_points: 'int', vip: 'bool', marketing_opt_in: 'bool', notes: 'text?', created_at: 'ts', last_login_at: 'ts?' },
    addresses: { id: 'id', customer_id: 'int ref=customers', kind: 'enum(shipping|billing)', line1: 'str(120)', line2: 'str(60)?', city: 'str(60)', region: 'str(60)?', postal_code: 'str(12)', country_code: 'char(2) ref=countries', is_default: 'bool', latitude: 'float', longitude: 'float' },
    orders: { id: 'id', order_number: 'str(20) unique', customer_id: 'int ref=customers', address_id: 'int ref=addresses', status: 'enum(pending|paid|shipped|delivered|cancelled|refunded)', order_date: 'ts', shipped_at: 'ts?', delivered_at: 'ts?', currency: 'char(3)', subtotal: 'dec(12,2)', tax: 'dec(12,2)', shipping_fee: 'dec(8,2)', total: 'dec(12,2)', coupon_code: 'str(20)?', note: 'str(300)?' },
    order_items: { id: 'id', order_id: 'int ref=orders', line_no: 'int', product_id: 'int ref=products', quantity: 'int', unit_price: 'dec(10,2)', discount_pct: 'int', line_total: 'dec(12,2)' },
    payments: { id: 'id', order_id: 'int ref=orders', method: 'enum(card|paypal|bank_transfer|cash_on_delivery|apple_pay)', amount: 'dec(12,2)', currency: 'char(3)', status: 'enum(captured|pending|failed|refunded)', transaction_ref: 'uuid', paid_at: 'ts?', card_last4: 'char(4)?' },
    reviews: { id: 'id', product_id: 'int ref=products', customer_id: 'int ref=customers', rating: 'int', title: 'str(120)', body: 'text?', helpful_votes: 'int', verified_purchase: 'bool', created_at: 'ts' },
  },
  hr: {
    departments: { id: 'id', name: 'str(60) unique', location: 'str(60)', budget: 'dec(14,2)', cost_center: 'char(6)' },
    jobs: { id: 'id', title: 'str(80)', grade: 'int', min_salary: 'dec(10,2)', max_salary: 'dec(10,2)' },
    employees: { id: 'id', employee_no: 'str(10) unique', first_name: 'str(60)', last_name: 'str(60)', email: 'str(120)', phone: 'str(30)?', hire_date: 'date', job_id: 'int ref=jobs', department_id: 'int ref=departments', manager_id: 'int? ref=employees', salary: 'dec(10,2)', commission_pct: 'dec(4,2)?', status: 'enum(active|on_leave|terminated)', termination_date: 'date?', bio: 'text?', photo: 'bytes?' },
    salary_history: { id: 'id', employee_id: 'int ref=employees', effective_date: 'date', salary: 'dec(10,2)', reason: 'enum(hired|raise|promotion|adjustment)' },
    attendance: { id: 'id', employee_id: 'int ref=employees', work_date: 'date', check_in: 'ts?', check_out: 'ts?', hours_worked: 'dec(4,2)?', status: 'enum(present|remote|sick|vacation|absent)' },
  },
  analytics: {
    sessions: { id: 'id', session_uuid: 'uuid', user_id: 'int?', started_at: 'ts', duration_sec: 'int', device: 'enum(desktop|mobile|tablet)', browser: 'str(30)', os: 'str(30)', country_code: 'char(2)', referrer: 'str(200)?', utm_source: 'str(40)?', is_bounce: 'bool' },
    page_views: { id: 'id', session_id: 'int ref=sessions', viewed_at: 'ts', path: 'str(200)', title: 'str(120)', load_ms: 'int', status_code: 'int', ip_address: 'ip', user_agent: 'str(200)' },
    daily_stats: { stat_date: 'date pk', visitors: 'int', page_views: 'int', orders: 'int', revenue: 'dec(14,2)', conversion_rate: 'dec(6,4)', avg_session_sec: 'int' },
  },
};

function parse(spec) {
  const m = /^(\w+)(?:\(([^)]*)\))?(\?)?((?: \S+)*)$/.exec(spec);
  const flags = m[4].trim().split(' ').filter(Boolean);
  const ref = flags.find((f) => f.startsWith('ref='));
  return { base: m[1], args: m[2] ? m[2].split(m[1] === 'enum' ? '|' : ',') : [], nullable: !!m[3], pk: m[1] === 'id' || flags.includes('pk'), unique: flags.includes('unique'), ref: ref ? ref.slice(4) : null };
}
for (const tables of Object.values(SCHEMA)) for (const cols of Object.values(tables)) for (const n of Object.keys(cols)) cols[n] = parse(cols[n]);
const pkOf = (db, table) => Object.keys(SCHEMA[db][table]).find((n) => SCHEMA[db][table][n].pk);

// ---------- sample data (same every run) ----------
let seed = 20261010;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const r2 = (x) => Math.round(x * 100) / 100;
const DAY = 86400000;
const START = Date.UTC(2023, 0, 1);
const END = Date.UTC(2026, 9, 1);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const hex = (n) => { let s = ''; while (s.length < n) s += Math.floor(rnd() * 16).toString(16); return s; };
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
const slug = (s) => s.normalize('NFD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user';

const COUNTRIES = [
  ['EG', 'Egypt', 'Africa', 'EGP', '+20', 112716598, 0, ['Cairo', 'Alexandria', 'Giza']], ['US', 'United States', 'North America', 'USD', '+1', 334914895, 0, ['New York', 'Austin', 'Seattle']],
  ['GB', 'United Kingdom', 'Europe', 'GBP', '+44', 68350000, 0, ['London', 'Manchester']], ['DE', 'Germany', 'Europe', 'EUR', '+49', 84482267, 1, ['Berlin', 'München']],
  ['SA', 'Saudi Arabia', 'Asia', 'SAR', '+966', 36947025, 0, ['Riyadh', 'Jeddah']], ['AE', 'United Arab Emirates', 'Asia', 'AED', '+971', 9516871, 0, ['Dubai', 'Abu Dhabi']],
  ['FR', 'France', 'Europe', 'EUR', '+33', 68170228, 1, ['Paris', 'Lyon']], ['IT', 'Italy', 'Europe', 'EUR', '+39', 58761146, 1, ['Roma', 'Milano']],
  ['ES', 'Spain', 'Europe', 'EUR', '+34', 48373336, 1, ['Madrid', 'Barcelona']], ['NL', 'Netherlands', 'Europe', 'EUR', '+31', 17879488, 1, ['Amsterdam', 'Rotterdam']],
  ['SE', 'Sweden', 'Europe', 'SEK', '+46', 10536632, 1, ['Stockholm', 'Göteborg']], ['PL', 'Poland', 'Europe', 'PLN', '+48', 36685849, 1, ['Warszawa', 'Kraków']],
  ['TR', 'Türkiye', 'Asia', 'TRY', '+90', 85326000, 0, ['İstanbul', 'Ankara']], ['IN', 'India', 'Asia', 'INR', '+91', 1428627663, 0, ['Mumbai', 'Bengaluru']],
  ['CN', 'China', 'Asia', 'CNY', '+86', 1410710000, 0, ['Shanghai', 'Beijing']], ['JP', 'Japan', 'Asia', 'JPY', '+81', 124516650, 0, ['Tokyo', 'Osaka']],
  ['KR', 'South Korea', 'Asia', 'KRW', '+82', 51712619, 0, ['Seoul', 'Busan']], ['AU', 'Australia', 'Oceania', 'AUD', '+61', 26638544, 0, ['Sydney', 'Melbourne']],
  ['BR', 'Brazil', 'South America', 'BRL', '+55', 216422446, 0, ['São Paulo', 'Rio de Janeiro']], ['MX', 'Mexico', 'North America', 'MXN', '+52', 128455567, 0, ['Ciudad de México', 'Guadalajara']],
  ['CA', 'Canada', 'North America', 'CAD', '+1', 40097761, 0, ['Toronto', 'Montréal']], ['ZA', 'South Africa', 'Africa', 'ZAR', '+27', 60414495, 0, ['Cape Town', 'Johannesburg']],
  ['NG', 'Nigeria', 'Africa', 'NGN', '+234', 223804632, 0, ['Lagos', 'Abuja']], ['KE', 'Kenya', 'Africa', 'KES', '+254', 55100586, 0, ['Nairobi', 'Mombasa']],
  ['MA', 'Morocco', 'Africa', 'MAD', '+212', 37840044, 0, ['Casablanca', 'Rabat']], ['AR', 'Argentina', 'South America', 'ARS', '+54', 46654581, 0, ['Buenos Aires', 'Córdoba']],
  ['ID', 'Indonesia', 'Asia', 'IDR', '+62', 277534122, 0, ['Jakarta', 'Surabaya']], ['SG', 'Singapore', 'Asia', 'SGD', '+65', 5917648, 0, ['Singapore']],
  ['NZ', 'New Zealand', 'Oceania', 'NZD', '+64', 5223100, 0, ['Auckland', 'Wellington']], ['CH', 'Switzerland', 'Europe', 'CHF', '+41', 8849852, 0, ['Zürich', 'Genève']],
];
const COUNTRY = Object.fromEntries(COUNTRIES.map((c) => [c[0], c]));
const anyCountry = () => COUNTRIES[Math.floor(Math.pow(rnd(), 1.7) * COUNTRIES.length)][0]; // the first ones come up more often
const FIRST = ['Ahmed', 'Fatima', 'Omar', 'Layla', 'Youssef', 'Mariam', 'Ali', 'Nour', 'Hassan', 'Salma', 'James', 'Mary', 'John', 'Emma', 'Liam', 'Olivia', 'Noah', 'Sophia', 'Lucas', 'Mia',
  'Hiroshi', 'Yuki', 'Wei', 'Mei', 'Carlos', 'Sofía', 'José', 'Zoë', 'François', 'Chloé', 'Björn', 'Søren', 'Élodie', 'Jürgen', 'Anaïs', 'Chinedu', 'Amara', 'Priya', 'Arjun', 'Ivan',
  'Olga', 'Dmitri', 'Anna', 'Kofi', 'Thabo', 'Aylin', 'Mehmet', 'أحمد', 'فاطمة', 'محمد', 'ليلى', '太郎', '美咲'];
const LAST = ['Hassan', 'El-Sayed', 'Mahmoud', 'Ibrahim', 'Khalil', 'Smith', 'Johnson', 'Williams', 'Brown', "O'Brien", 'García', 'Martínez', 'Müller', 'Schmidt', 'Dubois', 'Lefèvre', 'Rossi',
  'Bianchi', 'Tanaka', 'Sato', 'Wang', 'Li', 'Kim', 'Park', 'Singh', 'Patel', 'Ivanov', 'Petrov', 'Nowak', 'Kowalski', 'Andersson', 'Nielsen', 'Okafor', 'Mensah', 'Yılmaz', 'Demir',
  'Silva', 'Santos', 'Nguyen', 'Tran', 'الشريف', 'منصور', '山田'];
const DOMAINS = ['example.com', 'mail.test', 'inbox.example', 'corp.example.org', 'post.example.net'];
const STREETS = ['Nile St', 'Main St', 'High St', 'Tahrir Sq', 'Oak Ave', 'Station Rd', 'Park Lane', 'Rue de la Paix', 'Hauptstraße', 'Via Roma', 'Market St', 'Church Rd', 'King St', 'Corniche Rd'];
const CATS = [['Electronics', ['Phones', 'Laptops', 'Audio']], ['Home & Kitchen', ['Cookware', 'Furniture', 'Lighting']], ['Books', ['Fiction', 'Science', "Children's"]],
  ['Clothing', ['Men', 'Women', 'Shoes']], ['Sports & Outdoors', ['Fitness', 'Cycling', 'Camping']], ['Toys & Games', ['Board Games', 'Puzzles', 'Building Sets']]];
const NOUNS = { Phones: ['Smartphone', 'Phone Case', 'Charger'], Laptops: ['Laptop', 'Ultrabook', 'Docking Station'], Audio: ['Headphones', 'Speaker', 'Earbuds'], Cookware: ['Frying Pan', 'Saucepan', 'Knife Set'],
  Furniture: ['Desk', 'Bookshelf', 'Office Chair'], Lighting: ['Desk Lamp', 'Floor Lamp', 'LED Strip'], Fiction: ['Novel', 'Short Stories', 'Thriller'], Science: ['Physics Primer', 'Astronomy Atlas', 'Biology Guide'],
  "Children's": ['Picture Book', 'Activity Book', 'Fairy Tales'], Men: ['T-Shirt', 'Jacket', 'Jeans'], Women: ['Dress', 'Blouse', 'Scarf'], Shoes: ['Sneakers', 'Boots', 'Sandals'],
  Fitness: ['Yoga Mat', 'Dumbbell Set', 'Resistance Bands'], Cycling: ['Helmet', 'Bike Light', 'Water Bottle'], Camping: ['Tent', 'Sleeping Bag', 'Camp Stove'],
  'Board Games': ['Strategy Game', 'Card Game', 'Party Game'], Puzzles: ['1000-Piece Puzzle', '3D Puzzle', 'Wooden Puzzle'], 'Building Sets': ['Castle Set', 'Robot Kit', 'Race Car Set'] };
const ADJ = ['Ultra', 'Classic', 'Pro', 'Eco', 'Compact', 'Deluxe', 'Smart', 'Vintage', 'Premium', 'Essential'];
const TAGS = ['new', 'sale', 'bestseller', 'eco', 'gift', 'limited', 'imported', 'handmade', 'wireless', 'waterproof', 'kids', 'premium'];
const COLORS = ['black', 'white', 'red', 'blue', 'green', 'silver', 'gold', 'navy', 'beige'];
const SENTENCES = ['Works exactly as described.', 'Arrived two days early, well packed.', 'Good value for the price.', 'The colour is slightly different from the photos.', 'Would buy again 👍',
  "Didn't fit; returning it.", 'Excellent quality — très bien !', 'Battery life could be better.', 'جودة ممتازة وسعر مناسب', 'Five stars ⭐⭐⭐⭐⭐', 'Instructions were unclear, but support helped.',
  'Solid build, feels premium.', 'Not worth it at "full" price; wait for a sale.', 'Great gift idea.', 'Stopped working after a month.', '品質がとても良いです。'];
const paragraph = (n) => Array.from({ length: n }, () => pick(SENTENCES)).join(' ');
const PATHS = [['/', 'Home'], ['/products', 'All products'], ['/categories', 'Categories'], ['/cart', 'Your cart'], ['/checkout', 'Checkout'], ['/search', 'Search'], ['/login', 'Sign in'],
  ['/account', 'Your account'], ['/about', 'About us'], ['/contact', 'Contact'], ['/blog', 'Blog'], ['/help/shipping', 'Shipping & returns']];
const BROWSERS = [['Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Windows'],
  ['Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 'macOS'],
  ['Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Linux'],
  ['Mobile Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'iOS'],
  ['Chrome Mobile', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36', 'Android'],
  ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0', 'Windows']];

/** One extra per group first, the rest spread at random: how many children each parent gets. */
function spread(parents, total) {
  const n = new Array(parents).fill(1);
  for (let i = parents; i < total; i++) n[int(0, parents - 1)]++;
  return n;
}

function build() {
  const shop = {}; const hr = {}; const analytics = {};
  const person = () => { const first = pick(FIRST); const last = pick(LAST); return { first, last, mail: `${slug(first)}.${slug(last)}` }; };
  const phone = (cc) => `${COUNTRY[cc][4]} ${int(100, 999)} ${int(100, 999)} ${int(1000, 9999)}`;

  shop.countries = COUNTRIES.map(([code, name, continent, currency, phone_prefix, population, eu]) => ({ code, name, continent, currency, phone_prefix, population, eu_member: !!eu }));

  shop.categories = [];
  CATS.forEach(([name], i) => shop.categories.push({ id: i + 1, name, parent_id: null, slug: slug(name), description: `Everything in ${name}`, sort_order: (i + 1) * 10 }));
  const leaf = [];
  CATS.forEach(([top, subs], i) => subs.forEach((name, j) => {
    const id = shop.categories.length + 1;
    shop.categories.push({ id, name, parent_id: i + 1, slug: `${slug(top)}-${slug(name)}`, description: j === 2 ? null : `${name} (${top})`, sort_order: j + 1 });
    leaf.push({ id, name });
  }));

  shop.suppliers = Array.from({ length: 200 }, (_, i) => {
    const p = person(); const cc = anyCountry(); const name = `${pick(LAST.slice(0, 40))} ${pick(['Trading', 'Industries', 'Supply Co.', 'GmbH', 'Ltd', '& Sons', 'Global', 'Works'])}`;
    return { id: i + 1, name, contact_name: `${p.first} ${p.last}`, email: `${p.mail}@${slug(name)}.example`, phone: chance(0.9) ? phone(cc) : null, country_code: cc,
      rating: Math.round((2.5 + rnd() * 2.5) * 10) / 10, active: !chance(0.08), website: chance(0.7) ? `https://www.${slug(name)}.example` : null, created_at: new Date(START - int(30, 1500) * DAY + int(0, DAY)) };
  });

  shop.products = Array.from({ length: 2000 }, (_, i) => {
    const cat = pick(leaf); const price = r2(4 + Math.pow(rnd(), 3) * 1500); const released = START - 400 * DAY + int(0, 1700) * DAY;
    const attributes = { color: pick(COLORS), warranty_months: pick([0, 6, 12, 24, 36]), eco: chance(0.2), dimensions: { w: int(5, 120), h: int(2, 180), d: int(1, 80), unit: 'cm' } };
    if (chance(0.4)) attributes.size = pick(['XS', 'S', 'M', 'L', 'XL']);
    return { id: i + 1, sku: `SKU-${String(i + 1).padStart(6, '0')}`, name: `${pick(ADJ)} ${pick(NOUNS[cat.name])} ${pick(['', '', 'II', 'X', 'Mini', 'Max', 'Plus'])}`.trim() + ` ${int(100, 999)}`,
      category_id: cat.id, supplier_id: int(1, 200), price, cost: r2(price * (0.4 + rnd() * 0.4)), stock: chance(0.05) ? 0 : int(1, 900), weight_kg: chance(0.1) ? null : Math.round(rnd() * 25000) / 1000,
      tags: [...new Set(Array.from({ length: int(1, 4) }, () => pick(TAGS)))], attributes, discontinued: chance(0.06), released_date: day(released),
      description: chance(0.1) ? null : paragraph(chance(0.03) ? 60 : int(1, 5)), created_at: new Date(released + int(0, DAY)) };
  });

  shop.customers = Array.from({ length: 10000 }, (_, i) => {
    const p = person(); const cc = anyCountry(); const created = START - 200 * DAY + Math.floor((i / 10000) * (END - START + 150 * DAY)) + int(0, DAY);
    return { id: i + 1, first_name: p.first, last_name: p.last, email: `${p.mail}${i + 1}@${pick(DOMAINS)}`, phone: chance(0.8) ? phone(cc) : null, country_code: cc,
      birth_date: chance(0.85) ? day(Date.UTC(int(1945, 2007), int(0, 11), int(1, 28))) : null, gender: chance(0.9) ? pick(['F', 'M']) : null, loyalty_points: chance(0.3) ? 0 : int(1, 20000),
      vip: chance(0.05), marketing_opt_in: chance(0.6), notes: chance(0.07) ? paragraph(int(1, 3)) : null, created_at: new Date(created),
      last_login_at: chance(0.8) ? new Date(Math.min(END, created + int(0, 600) * DAY + int(0, DAY))) : null };
  });

  const addressOf = [];
  shop.addresses = Array.from({ length: 12000 }, (_, i) => {
    const first = i < 10000; const customer_id = first ? i + 1 : int(1, 10000); const cc = chance(0.9) ? shop.customers[customer_id - 1].country_code : anyCountry();
    if (first) addressOf[customer_id] = i + 1;
    return { id: i + 1, customer_id, kind: first ? 'shipping' : 'billing', line1: `${int(1, 250)} ${pick(STREETS)}`, line2: chance(0.25) ? `Apt ${int(1, 90)}` : null, city: pick(COUNTRY[cc][7]),
      region: chance(0.3) ? pick(['North', 'South', 'East', 'West', 'Central']) : null, postal_code: String(int(10000, 99999)), country_code: cc, is_default: first,
      latitude: Math.round((rnd() * 120 - 50) * 1e6) / 1e6, longitude: Math.round((rnd() * 300 - 150) * 1e6) / 1e6 };
  });

  const ORDERS = 30000; const perOrder = spread(ORDERS, 100000);
  shop.orders = []; shop.order_items = []; shop.payments = [];
  for (let i = 0; i < ORDERS; i++) {
    const id = i + 1; const customer_id = 1 + Math.floor(Math.pow(rnd(), 1.5) * 10000); const when = START + Math.floor((i / ORDERS) * (END - START)) + int(0, DAY);
    const age = (END - when) / DAY; const x = rnd();
    const status = x < 0.05 ? 'cancelled' : x < 0.07 ? 'refunded' : age > 20 ? 'delivered' : age > 7 ? pick(['shipped', 'delivered']) : pick(['pending', 'paid', 'shipped']);
    let subtotal = 0;
    for (let l = 0; l < perOrder[i]; l++) {
      const product = shop.products[int(0, 1999)]; const quantity = 1 + Math.floor(Math.pow(rnd(), 2.5) * 5); const discount_pct = pick([0, 0, 0, 0, 5, 10, 15, 20]);
      const line_total = r2(quantity * product.price * (1 - discount_pct / 100)); subtotal += line_total;
      shop.order_items.push({ id: shop.order_items.length + 1, order_id: id, line_no: l + 1, product_id: product.id, quantity, unit_price: product.price, discount_pct, line_total });
    }
    subtotal = r2(subtotal); const tax = r2(subtotal * 0.14); const shipping_fee = subtotal > 100 ? 0 : 4.99; const total = r2(subtotal + tax + shipping_fee);
    const currency = COUNTRY[shop.customers[customer_id - 1].country_code][3]; const sent = ['shipped', 'delivered', 'refunded'].includes(status); const got = ['delivered', 'refunded'].includes(status);
    const shipped = when + int(1, 3) * DAY + int(0, DAY);
    shop.orders.push({ id, order_number: `SO-${new Date(when).getUTCFullYear()}-${String(id).padStart(6, '0')}`, customer_id, address_id: addressOf[customer_id], status, order_date: new Date(when),
      shipped_at: sent ? new Date(shipped) : null, delivered_at: got ? new Date(shipped + int(1, 6) * DAY) : null, currency, subtotal, tax, shipping_fee, total,
      coupon_code: chance(0.12) ? pick(['WELCOME10', 'SUMMER25', 'FREESHIP', 'VIP-2026', 'RAMADAN']) : null, note: chance(0.06) ? pick(['Leave at the door', 'Gift wrap please 🎁', 'Call before delivery', "Don't ring the bell", 'اتصل قبل التوصيل']) : null });
    const method = pick(['card', 'card', 'card', 'paypal', 'bank_transfer', 'cash_on_delivery', 'apple_pay']);
    const pay = status === 'pending' ? 'pending' : status === 'refunded' ? 'refunded' : status === 'cancelled' ? pick(['failed', 'refunded']) : 'captured';
    shop.payments.push({ id, order_id: id, method, amount: total, currency, status: pay, transaction_ref: uuid(), paid_at: pay === 'pending' || pay === 'failed' ? null : new Date(when + int(10, 3600) * 1000),
      card_last4: method === 'card' || method === 'apple_pay' ? String(int(0, 9999)).padStart(4, '0') : null });
  }

  shop.reviews = Array.from({ length: 15000 }, (_, i) => {
    const rating = pick([5, 5, 5, 4, 4, 4, 3, 3, 2, 1]);
    return { id: i + 1, product_id: 1 + Math.floor(Math.pow(rnd(), 2) * 2000), customer_id: int(1, 10000), rating, title: pick(SENTENCES).slice(0, 110), body: chance(0.15) ? null : (chance(0.05) ? `${paragraph(8)}\n\n${paragraph(20)}` : paragraph(int(1, 4))),
      helpful_votes: Math.floor(Math.pow(rnd(), 4) * 300), verified_purchase: chance(0.7), created_at: new Date(START + Math.floor((i / 15000) * (END - START)) + int(0, DAY)) };
  });

  // hr
  const DEPTS = [['Engineering', 'Cairo'], ['Product', 'Cairo'], ['Design', 'Berlin'], ['Sales', 'Dubai'], ['Marketing', 'London'], ['Customer Support', 'Alexandria'], ['Finance', 'Cairo'], ['Human Resources', 'Cairo'],
    ['Legal', 'London'], ['Operations', 'Riyadh'], ['IT', 'Berlin'], ['Research', 'Zürich']];
  hr.departments = DEPTS.map(([name, location], i) => ({ id: i + 1, name, location, budget: r2(250000 + rnd() * 4750000), cost_center: `CC${String(1000 + i * 7)}` }));
  const JOBS = [['Intern', 1, 800, 1500], ['Junior Engineer', 2, 2000, 3500], ['Engineer', 3, 3200, 5500], ['Senior Engineer', 4, 5000, 8500], ['Staff Engineer', 5, 8000, 12000], ['Designer', 3, 2800, 5200],
    ['Product Manager', 4, 4800, 9000], ['Sales Representative', 2, 1800, 4000], ['Account Executive', 3, 3000, 6500], ['Support Agent', 2, 1500, 2800], ['Accountant', 3, 2500, 4800],
    ['HR Specialist', 3, 2400, 4500], ['Team Lead', 5, 7000, 11000], ['Director', 6, 10000, 18000], ['Vice President', 7, 16000, 30000]];
  hr.jobs = JOBS.map(([title, grade, min_salary, max_salary], i) => ({ id: i + 1, title, grade, min_salary, max_salary }));
  hr.employees = []; hr.salary_history = [];
  for (let i = 0; i < 5000; i++) {
    const id = i + 1; const p = person(); const job = i === 0 ? 15 : i < 12 ? 14 : i < 300 ? 13 : int(1, 12); const j = hr.jobs[job - 1];
    const hired = Date.UTC(2010, 0, 4) + Math.floor(Math.pow(i / 5000, 0.6) * (END - 30 * DAY - Date.UTC(2010, 0, 4))); const x = rnd();
    const status = x < 0.1 ? 'terminated' : x < 0.14 ? 'on_leave' : 'active'; const salary = r2(j.min_salary + rnd() * (j.max_salary - j.min_salary));
    const photo = id % 10 === 0 ? Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(hex(80), 'hex')]) : null;
    hr.employees.push({ id, employee_no: `E${String(id).padStart(5, '0')}`, first_name: p.first, last_name: p.last, email: `${p.mail}${id}@lookup-corp.example`, phone: chance(0.85) ? phone('EG') : null, hire_date: day(hired),
      job_id: job, department_id: i < 12 ? i + 1 : int(1, 12), manager_id: i === 0 ? null : i < 12 ? 1 : i < 300 ? int(2, 12) : int(13, 300), salary, commission_pct: job === 8 || job === 9 ? r2(rnd() * 0.3) : null,
      status, termination_date: status === 'terminated' ? day(Math.min(END, hired + int(60, 2000) * DAY)) : null, bio: chance(0.2) ? `${p.first} joined in ${new Date(hired).getUTCFullYear()}. ${paragraph(2)}` : null, photo });
    [0.8, 0.9, 1].forEach((f, k) => hr.salary_history.push({ id: hr.salary_history.length + 1, employee_id: id, effective_date: day(hired + Math.floor((k / 3) * (END - hired))), salary: r2(salary * f), reason: k === 0 ? 'hired' : pick(['raise', 'raise', 'promotion', 'adjustment']) }));
  }
  const workdays = []; for (let d = END - DAY; workdays.length < 10; d -= DAY) if (![5, 6].includes(new Date(d).getUTCDay())) workdays.unshift(d); // Friday / Saturday off
  hr.attendance = [];
  for (const d of workdays) for (let e = 1; e <= 5000; e++) {
    const x = rnd(); const status = x < 0.78 ? 'present' : x < 0.9 ? 'remote' : x < 0.94 ? 'sick' : x < 0.98 ? 'vacation' : 'absent'; const worked = status === 'present' || status === 'remote';
    const inAt = d + int(7 * 3600, 10 * 3600) * 1000; const hours = Math.round((6 + rnd() * 4) * 100) / 100; const open = worked && chance(0.02); // forgot to check out
    hr.attendance.push({ id: hr.attendance.length + 1, employee_id: e, work_date: day(d), check_in: worked ? new Date(inAt) : null, check_out: worked && !open ? new Date(inAt + Math.round(hours * 3600000)) : null, hours_worked: worked && !open ? hours : null, status });
  }

  // analytics
  const SESSIONS = 20000; const perSession = spread(SESSIONS, 100000); const A_START = END - 1000 * DAY;
  analytics.sessions = []; analytics.page_views = [];
  for (let i = 0; i < SESSIONS; i++) {
    const id = i + 1; const b = pick(BROWSERS); const started = A_START + Math.floor((i / SESSIONS) * 1000 * DAY) + int(0, DAY / 20); const mobile = b[2] === 'iOS' || b[2] === 'Android';
    const ip = `${pick([41, 62, 81, 102, 156, 185, 196, 197, 203])}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`; let t = started;
    for (let v = 0; v < perSession[i]; v++) {
      const product = chance(0.4); const p = product ? [`/products/${int(1, 2000)}`, 'Product details'] : pick(PATHS); t += int(3, 240) * 1000;
      analytics.page_views.push({ id: analytics.page_views.length + 1, session_id: id, viewed_at: new Date(t), path: p[0] + (p[0] === '/search' ? `?q=${pick(TAGS)}` : ''), title: p[1], load_ms: int(40, 400) + Math.floor(Math.pow(rnd(), 6) * 6000),
        status_code: chance(0.97) ? 200 : pick([301, 404, 404, 500]), ip_address: ip, user_agent: b[1] });
    }
    analytics.sessions.push({ id, session_uuid: uuid(), user_id: chance(0.45) ? int(1, 10000) : null, started_at: new Date(started), duration_sec: Math.round((t - started) / 1000), device: mobile ? (chance(0.85) ? 'mobile' : 'tablet') : 'desktop',
      browser: b[0], os: b[2], country_code: anyCountry(), referrer: chance(0.5) ? pick(['https://www.google.com/', 'https://www.bing.com/', 'https://t.co/', 'https://www.facebook.com/', 'https://news.example/deals']) : null,
      utm_source: chance(0.25) ? pick(['newsletter', 'google-ads', 'facebook', 'partner', 'tiktok']) : null, is_bounce: perSession[i] === 1 });
  }
  analytics.daily_stats = Array.from({ length: 1000 }, (_, i) => {
    const visitors = 800 + Math.floor(i * 2.5) + int(0, 600); const orders = Math.round(visitors * (0.01 + rnd() * 0.03));
    return { stat_date: day(A_START + i * DAY), visitors, page_views: visitors * int(3, 7), orders, revenue: r2(orders * (40 + rnd() * 80)), conversion_rate: Math.round((orders / visitors) * 10000) / 10000, avg_session_sec: int(60, 480) };
  });
  return { shop, hr, analytics };
}

// ---------- shared helpers ----------
const names = (db, table) => Object.keys(SCHEMA[db][table]);
const log = (engine, text) => console.log(`[${engine}] ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function* chunks(rows, size) { for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size); }
/** Keeps trying until the server answers (a database that is still starting), up to 6 minutes. */
async function waitFor(engine, fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 120) throw e;
      if (i % 10 === 0) log(engine, `waiting for the server (${String(e.message).split('\n')[0]})`);
      await sleep(3000);
    }
  }
}
/** One value as this engine's driver wants it. */
function conv(engine, c, v) {
  if (v == null) return null;
  switch (c.base) {
    case 'bool': return engine === 'oracle' || engine === 'mysql' ? (v ? 1 : 0) : v;
    case 'date': return engine === 'oracle' || engine === 'mongodb' ? new Date(`${v}T00:00:00Z`) : v;
    case 'ts': return engine === 'clickhouse' ? v.toISOString().replace('T', ' ').slice(0, 23) : v;
    case 'json': case 'tags': return engine === 'mysql' || engine === 'oracle' || (engine === 'clickhouse' && c.base === 'json') ? JSON.stringify(v) : v;
    case 'bytes': return engine === 'clickhouse' ? v.toString('base64') : v;
    default: return v;
  }
}
const rowsFor = (engine, db, table, rows) => { const cols = SCHEMA[db][table]; const ns = names(db, table); return rows.map((r) => ns.map((n) => conv(engine, cols[n], r[n]))); };
const expected = (data) => { const out = {}; for (const db of Object.keys(SCHEMA)) for (const t of Object.keys(SCHEMA[db])) out[`${db}.${t}`] = data[db][t].length; return out; };
const same = (a, b) => Object.keys(b).every((k) => a[k] === b[k]);

// ---------- PostgreSQL ----------
const pgType = (c, table, n) => ({ id: 'integer GENERATED BY DEFAULT AS IDENTITY', int: 'integer', bigint: 'bigint', dec: `numeric(${c.args})`, float: 'double precision', str: `varchar(${c.args})`, char: `char(${c.args})`,
  text: 'text', bool: 'boolean', date: 'date', ts: 'timestamptz', json: 'jsonb', tags: 'text[]', bytes: 'bytea', enum: `${table}_${n}`, uuid: 'uuid', ip: 'inet' }[c.base]);
const PG_EXTRAS = {
  shop: [
    "COMMENT ON TABLE customers IS 'People who signed up or bought something'",
    "COMMENT ON COLUMN products.attributes IS 'Free-form details: color, size, warranty_months, dimensions'",
    'CREATE SEQUENCE invoice_seq START 50001',
    'CREATE FUNCTION order_item_count(p_order integer) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM order_items WHERE order_id = p_order $$',
    'CREATE VIEW best_sellers AS SELECT p.id, p.sku, p.name, sum(i.quantity) AS units, sum(i.line_total) AS revenue FROM products p JOIN order_items i ON i.product_id = p.id GROUP BY p.id ORDER BY units DESC LIMIT 100',
    'CREATE SCHEMA reporting',
    "CREATE VIEW reporting.customer_totals AS SELECT c.id AS customer_id, c.first_name, c.last_name, c.country_code, count(o.id) AS orders, coalesce(sum(o.total), 0) AS spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'refunded') GROUP BY c.id",
    "CREATE MATERIALIZED VIEW reporting.monthly_sales AS SELECT date_trunc('month', order_date)::date AS month, currency, count(*) AS orders, sum(total) AS revenue FROM orders WHERE status NOT IN ('cancelled', 'refunded') GROUP BY 1, 2 ORDER BY 1, 2",
  ],
  hr: ["CREATE VIEW department_headcount AS SELECT d.id, d.name, count(e.id) AS employees, round(avg(e.salary), 2) AS avg_salary FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.status <> 'terminated' GROUP BY d.id, d.name"],
  analytics: ['CREATE VIEW top_pages AS SELECT path, count(*) AS views, round(avg(load_ms)) AS avg_load_ms FROM page_views GROUP BY path ORDER BY views DESC LIMIT 50'],
};
const pgOpen = async (database) => { const c = new (require('pg').Client)({ ...T.postgres, user: 'lookup', password: PW, database }); c.on('error', () => {}); await c.connect(); return c; };
async function countPostgres() {
  const out = {};
  for (const db of Object.keys(SCHEMA)) {
    const c = await pgOpen(db);
    try { for (const t of Object.keys(SCHEMA[db])) out[`${db}.${t}`] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n); } finally { await c.end(); }
  }
  return out;
}
async function seedPostgres(data) {
  const admin = await waitFor('postgres', () => pgOpen('postgres'));
  for (const db of Object.keys(SCHEMA)) { await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${db}`); }
  await admin.end();
  for (const db of Object.keys(SCHEMA)) {
    const c = await pgOpen(db);
    for (const [table, cols] of Object.entries(SCHEMA[db])) {
      const ns = names(db, table);
      for (const n of ns) if (cols[n].base === 'enum') await c.query(`CREATE TYPE ${table}_${n} AS ENUM (${cols[n].args.map((a) => `'${a}'`).join(', ')})`);
      await c.query(`CREATE TABLE ${table} (${ns.map((n) => { const k = cols[n]; return `${n} ${pgType(k, table, n)}${k.pk ? ' PRIMARY KEY' : k.nullable ? '' : ' NOT NULL'}${k.unique ? ' UNIQUE' : ''}${k.ref ? ` REFERENCES ${k.ref}` : ''}`; }).join(', ')})`);
      const rows = rowsFor('postgres', db, table, data[db][table]);
      for (const part of chunks(rows, Math.floor(30000 / ns.length))) {
        await c.query(`INSERT INTO ${table} (${ns.join(', ')}) VALUES ${part.map((_, r) => `(${ns.map((__, i) => `$${r * ns.length + i + 1}`).join(',')})`).join(',')}`, part.flat());
      }
      for (const n of ns) if (cols[n].ref) await c.query(`CREATE INDEX ${table}_${n}_idx ON ${table} (${n})`);
      if (cols.id) await c.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT max(id) FROM ${table}))`);
      log('postgres', `${db}.${table}: ${rows.length} rows`);
    }
    for (const sql of PG_EXTRAS[db]) await c.query(sql);
    await c.query('ANALYZE');
    await c.end();
  }
}

// ---------- MySQL ----------
const myType = (c) => ({ id: 'INT NOT NULL AUTO_INCREMENT', int: 'INT', bigint: 'BIGINT', dec: `DECIMAL(${c.args})`, float: 'DOUBLE', str: `VARCHAR(${c.args})`, char: `CHAR(${c.args})`, text: 'TEXT', bool: 'TINYINT(1)',
  date: 'DATE', ts: 'DATETIME(3)', json: 'JSON', tags: 'JSON', bytes: 'BLOB', enum: `ENUM(${c.args.map((a) => `'${a}'`).join(',')})`, uuid: 'CHAR(36)', ip: 'VARCHAR(45)' }[c.base]);
const MY_EXTRAS = {
  shop: [
    "ALTER TABLE customers COMMENT = 'People who signed up or bought something'",
    'CREATE FUNCTION order_item_count(p_order INT) RETURNS INT READS SQL DATA RETURN (SELECT COUNT(*) FROM order_items WHERE order_id = p_order)',
    'CREATE PROCEDURE customer_orders(IN p_customer INT) READS SQL DATA SELECT * FROM orders WHERE customer_id = p_customer ORDER BY order_date DESC',
    'CREATE VIEW best_sellers AS SELECT p.id, p.sku, p.name, SUM(i.quantity) AS units, SUM(i.line_total) AS revenue FROM products p JOIN order_items i ON i.product_id = p.id GROUP BY p.id, p.sku, p.name ORDER BY units DESC LIMIT 100',
    "CREATE VIEW customer_totals AS SELECT c.id AS customer_id, c.first_name, c.last_name, c.country_code, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'refunded') GROUP BY c.id, c.first_name, c.last_name, c.country_code",
    "CREATE VIEW monthly_sales AS SELECT DATE_FORMAT(order_date, '%Y-%m-01') AS month, currency, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE status NOT IN ('cancelled', 'refunded') GROUP BY 1, 2",
  ],
  hr: ["CREATE VIEW department_headcount AS SELECT d.id, d.name, COUNT(e.id) AS employees, ROUND(AVG(e.salary), 2) AS avg_salary FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.status <> 'terminated' GROUP BY d.id, d.name"],
  analytics: ['CREATE VIEW top_pages AS SELECT path, COUNT(*) AS views, ROUND(AVG(load_ms)) AS avg_load_ms FROM page_views GROUP BY path ORDER BY views DESC LIMIT 50'],
};
const myOpen = (user = 'lookup') => require('mysql2/promise').createConnection({ ...T.mysql, user, password: PW, timezone: 'Z', charset: 'utf8mb4' });
async function countMysql() {
  const c = await myOpen(); const out = {};
  try { for (const db of Object.keys(SCHEMA)) for (const t of Object.keys(SCHEMA[db])) out[`${db}.${t}`] = Number((await c.query(`SELECT COUNT(*) AS n FROM \`${db}\`.\`${t}\``))[0][0].n); } finally { await c.end(); }
  return out;
}
async function seedMysql(data) {
  const c = await waitFor('mysql', () => myOpen('root'));
  await c.query("CREATE USER IF NOT EXISTS 'lookup'@'%' IDENTIFIED BY 'lookup'");
  await c.query("GRANT ALL PRIVILEGES ON *.* TO 'lookup'@'%' WITH GRANT OPTION");
  for (const db of Object.keys(SCHEMA)) {
    await c.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await c.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await c.query(`USE \`${db}\``);
    for (const [table, cols] of Object.entries(SCHEMA[db])) {
      const ns = names(db, table);
      const parts = ns.map((n) => { const k = cols[n]; return `\`${n}\` ${myType(k)}${k.base === 'id' || k.nullable ? '' : ' NOT NULL'}${k.unique ? ' UNIQUE' : ''}`; });
      parts.push(`PRIMARY KEY (\`${pkOf(db, table)}\`)`);
      for (const n of ns) if (cols[n].ref) parts.push(`CONSTRAINT \`fk_${table}_${n}\` FOREIGN KEY (\`${n}\`) REFERENCES \`${cols[n].ref}\` (\`${pkOf(db, cols[n].ref)}\`)`);
      await c.query(`CREATE TABLE \`${table}\` (${parts.join(', ')}) ENGINE=InnoDB`);
      const rows = rowsFor('mysql', db, table, data[db][table]);
      for (const part of chunks(rows, 2000)) await c.query(`INSERT INTO \`${table}\` (${ns.map((n) => `\`${n}\``).join(', ')}) VALUES ?`, [part]);
      log('mysql', `${db}.${table}: ${rows.length} rows`);
    }
    for (const sql of MY_EXTRAS[db]) await c.query(sql);
  }
  await c.end();
}

// ---------- Oracle ----------
const oraType = (c, n) => ({ id: 'NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY', int: 'NUMBER(10)', bigint: 'NUMBER(19)', dec: `NUMBER(${c.args})`, float: 'BINARY_DOUBLE', str: `VARCHAR2(${c.args} CHAR)`, char: `CHAR(${c.args})`,
  text: 'CLOB', bool: `NUMBER(1) CHECK (${n} IN (0, 1))`, date: 'DATE', ts: 'TIMESTAMP(3)', json: `VARCHAR2(4000) CHECK (${n} IS JSON)`, tags: `VARCHAR2(400) CHECK (${n} IS JSON)`, bytes: 'BLOB',
  enum: `VARCHAR2(20) CHECK (${n} IN (${c.args.map((a) => `'${a}'`).join(', ')}))`, uuid: 'VARCHAR2(36)', ip: 'VARCHAR2(45)' }[c.base]);
const ORA_EXTRAS = {
  shop: [
    "COMMENT ON TABLE customers IS 'People who signed up or bought something'",
    'CREATE SEQUENCE invoice_seq START WITH 50001',
    'CREATE VIEW best_sellers AS SELECT p.id, p.sku, p.name, SUM(i.quantity) AS units, SUM(i.line_total) AS revenue FROM products p JOIN order_items i ON i.product_id = p.id GROUP BY p.id, p.sku, p.name ORDER BY units DESC FETCH FIRST 100 ROWS ONLY',
    "CREATE VIEW customer_totals AS SELECT c.id AS customer_id, c.first_name, c.last_name, c.country_code, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'refunded') GROUP BY c.id, c.first_name, c.last_name, c.country_code",
    "CREATE MATERIALIZED VIEW monthly_sales AS SELECT TRUNC(CAST(order_date AS DATE), 'MM') AS month, currency, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE status NOT IN ('cancelled', 'refunded') GROUP BY TRUNC(CAST(order_date AS DATE), 'MM'), currency",
    'CREATE FUNCTION order_item_count(p_order IN NUMBER) RETURN NUMBER IS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM order_items WHERE order_id = p_order; RETURN n; END;',
    'CREATE PROCEDURE add_loyalty_points(p_customer IN NUMBER, p_points IN NUMBER) IS BEGIN UPDATE customers SET loyalty_points = loyalty_points + p_points WHERE id = p_customer; END;',
    'CREATE PACKAGE shop_api AS FUNCTION customer_spent(p_customer IN NUMBER) RETURN NUMBER; PROCEDURE cancel_order(p_order IN NUMBER); END shop_api;',
    "CREATE PACKAGE BODY shop_api AS\n  FUNCTION customer_spent(p_customer IN NUMBER) RETURN NUMBER IS n NUMBER;\n  BEGIN\n    SELECT COALESCE(SUM(total), 0) INTO n FROM orders WHERE customer_id = p_customer AND status NOT IN ('cancelled', 'refunded');\n    RETURN n;\n  END;\n  PROCEDURE cancel_order(p_order IN NUMBER) IS\n  BEGIN\n    UPDATE orders SET status = 'cancelled' WHERE id = p_order AND status IN ('pending', 'paid');\n    DBMS_OUTPUT.PUT_LINE('Cancelled: ' || SQL%ROWCOUNT);\n  END;\nEND shop_api;",
    'CREATE TRIGGER reviews_bi BEFORE INSERT ON reviews FOR EACH ROW BEGIN IF :NEW.created_at IS NULL THEN :NEW.created_at := SYSTIMESTAMP; END IF; END;',
    'CREATE TYPE t_money_list AS TABLE OF NUMBER(12, 2)',
    'CREATE SYNONYM clients FOR customers',
  ],
  hr: [
    "CREATE VIEW department_headcount AS SELECT d.id, d.name, COUNT(e.id) AS employees, ROUND(AVG(e.salary), 2) AS avg_salary FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.status <> 'terminated' GROUP BY d.id, d.name",
    'CREATE SEQUENCE badge_seq START WITH 9001',
  ],
  analytics: ['CREATE VIEW top_pages AS SELECT path, COUNT(*) AS views, ROUND(AVG(load_ms)) AS avg_load_ms FROM page_views GROUP BY path ORDER BY views DESC FETCH FIRST 50 ROWS ONLY'],
};
const oraOpen = (user, pdb) => require('oracledb').getConnection({ user, password: PW, connectString: `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${T.oracle.host})(PORT=${T.oracle.port}))(CONNECT_DATA=(SERVICE_NAME=${pdb})))` });
async function countOracle() {
  const out = {};
  for (const db of Object.keys(SCHEMA)) {
    const c = await oraOpen('lookup', ORACLE_PDB[db]);
    try { for (const t of Object.keys(SCHEMA[db])) out[`${db}.${t}`] = (await c.execute(`SELECT COUNT(*) FROM ${db}.${t}`)).rows[0][0]; } finally { await c.close(); }
  }
  return out;
}
async function seedOracle(data) {
  const ora = require('oracledb');
  const ignore = (codes) => (e) => { if (!codes.some((k) => String(e.message).includes(k))) throw e; };
  for (const pdb of new Set(Object.values(ORACLE_PDB))) {
    const sys = await waitFor('oracle', () => oraOpen('system', pdb));
    await sys.execute('CREATE USER lookup IDENTIFIED BY lookup').catch(ignore(['ORA-01920']));
    await sys.execute('GRANT DBA, UNLIMITED TABLESPACE TO lookup');
    for (const db of Object.keys(SCHEMA).filter((d) => ORACLE_PDB[d] === pdb)) {
      await sys.execute(`DROP USER ${db} CASCADE`).catch(ignore(['ORA-01918']));
      await sys.execute(`CREATE USER ${db} IDENTIFIED BY lookup`);
      await sys.execute(`GRANT CONNECT, RESOURCE, UNLIMITED TABLESPACE, CREATE VIEW, CREATE MATERIALIZED VIEW, CREATE SYNONYM, CREATE SEQUENCE, CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE TO ${db}`);
    }
    await sys.close();
  }
  for (const db of Object.keys(SCHEMA)) {
    const c = await oraOpen(db, ORACLE_PDB[db]);
    await c.execute("ALTER SESSION SET TIME_ZONE = 'UTC'");
    for (const [table, cols] of Object.entries(SCHEMA[db])) {
      const ns = names(db, table);
      await c.execute(`CREATE TABLE ${table} (${ns.map((n) => { const k = cols[n]; return `${n} ${oraType(k, n)}${k.pk ? ' PRIMARY KEY' : k.nullable ? '' : ' NOT NULL'}${k.unique ? ' UNIQUE' : ''}${k.ref ? ` REFERENCES ${k.ref}` : ''}`; }).join(', ')})`);
      const rows = rowsFor('oracle', db, table, data[db][table]);
      const bindDefs = ns.map((n, i) => {
        const b = cols[n].base;
        if (['id', 'int', 'bigint', 'dec', 'float', 'bool'].includes(b)) return { type: ora.NUMBER };
        if (b === 'date') return { type: ora.DB_TYPE_DATE };
        if (b === 'ts') return { type: ora.DB_TYPE_TIMESTAMP };
        if (b === 'bytes') return { type: ora.BUFFER, maxSize: 2000 };
        return { type: ora.STRING, maxSize: rows.reduce((m, r) => Math.max(m, r[i] == null ? 0 : Buffer.byteLength(r[i])), 1) };
      });
      for (const part of chunks(rows, 5000)) await c.executeMany(`INSERT INTO ${table} (${ns.join(', ')}) VALUES (${ns.map((_, i) => `:${i + 1}`).join(', ')})`, part, { bindDefs, autoCommit: true });
      for (const n of ns) if (cols[n].ref) await c.execute(`CREATE INDEX ${table}_${n}_ix ON ${table} (${n})`);
      if (cols.id) await c.execute(`ALTER TABLE ${table} MODIFY id GENERATED BY DEFAULT ON NULL AS IDENTITY (START WITH LIMIT VALUE)`);
      log('oracle', `${ORACLE_PDB[db]} ${db}.${table}: ${rows.length} rows`);
    }
    for (const sql of ORA_EXTRAS[db]) await c.execute(sql);
    await c.execute(`BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(USER); END;`);
    await c.close();
  }
}

// ---------- ClickHouse ----------
const chType = (c) => {
  const t = { id: 'UInt32', int: 'Int32', bigint: 'Int64', dec: `Decimal(${c.args})`, float: 'Float64', str: 'String', char: 'String', text: 'String', bool: 'Bool', date: 'Date32', ts: "DateTime64(3, 'UTC')",
    json: 'String', tags: 'Array(String)', bytes: 'String', enum: `Enum8(${c.args.map((a, i) => `'${a}' = ${i + 1}`).join(', ')})`, uuid: 'UUID', ip: 'IPv4' }[c.base];
  return c.nullable ? `Nullable(${t})` : c.base === 'char' ? 'LowCardinality(String)' : t;
};
const CH_BEFORE = { analytics: [
  'CREATE TABLE analytics.page_views_per_day (day Date, path String, views UInt64) ENGINE = SummingMergeTree ORDER BY (day, path)',
  'CREATE MATERIALIZED VIEW analytics.page_views_per_day_mv TO analytics.page_views_per_day AS SELECT toDate(viewed_at) AS day, path, count() AS views FROM analytics.page_views GROUP BY day, path',
] };
const CH_EXTRAS = {
  shop: [
    'CREATE VIEW shop.best_sellers AS SELECT p.id AS id, p.sku AS sku, p.name AS name, sum(i.quantity) AS units, sum(i.line_total) AS revenue FROM shop.products AS p INNER JOIN shop.order_items AS i ON i.product_id = p.id GROUP BY p.id, p.sku, p.name ORDER BY units DESC LIMIT 100',
    "CREATE VIEW shop.monthly_sales AS SELECT toStartOfMonth(order_date) AS month, currency, count() AS orders, sum(total) AS revenue FROM shop.orders WHERE status NOT IN ('cancelled', 'refunded') GROUP BY month, currency ORDER BY month, currency",
  ],
  hr: ["CREATE VIEW hr.department_headcount AS SELECT d.id AS id, d.name AS name, countIf(e.status != 'terminated') AS employees, round(avgIf(e.salary, e.status != 'terminated'), 2) AS avg_salary FROM hr.departments AS d INNER JOIN hr.employees AS e ON e.department_id = d.id GROUP BY d.id, d.name"],
  analytics: ['CREATE VIEW analytics.top_pages AS SELECT path, count() AS views, round(avg(load_ms)) AS avg_load_ms FROM analytics.page_views GROUP BY path ORDER BY views DESC LIMIT 50'],
};
const chOpen = () => { const ch = require('@clickhouse/client'); return ch.createClient({ url: `http://${T.clickhouse.host}:${T.clickhouse.port}`, username: 'lookup', password: PW, log: { level: ch.ClickHouseLogLevel.OFF } }); };
async function countClickhouse() {
  const c = chOpen(); const out = {};
  try { for (const db of Object.keys(SCHEMA)) for (const t of Object.keys(SCHEMA[db])) out[`${db}.${t}`] = Number((await (await c.query({ query: `SELECT count() AS n FROM ${db}.${t}`, format: 'JSONEachRow' })).json())[0].n); } finally { await c.close(); }
  return out;
}
async function seedClickhouse(data) {
  const c = chOpen();
  await waitFor('clickhouse', async () => { const r = await c.ping(); if (!r.success) throw r.error || new Error('no answer'); });
  for (const db of Object.keys(SCHEMA)) {
    await c.command({ query: `DROP DATABASE IF EXISTS ${db} SYNC` });
    await c.command({ query: `CREATE DATABASE ${db}` });
    for (const [table, cols] of Object.entries(SCHEMA[db])) {
      const ns = names(db, table);
      await c.command({ query: `CREATE TABLE ${db}.${table} (${ns.map((n) => `${n} ${chType(cols[n])}`).join(', ')}) ENGINE = MergeTree ORDER BY ${pkOf(db, table)}` });
    }
    for (const sql of CH_BEFORE[db] || []) await c.command({ query: sql });
    for (const table of Object.keys(SCHEMA[db])) {
      const ns = names(db, table); const rows = rowsFor('clickhouse', db, table, data[db][table]);
      for (const part of chunks(rows, 25000)) await c.insert({ table: `${db}.${table}`, values: part.map((r) => Object.fromEntries(ns.map((n, i) => [n, r[i]]))), format: 'JSONEachRow' });
      log('clickhouse', `${db}.${table}: ${rows.length} rows`);
    }
    for (const sql of CH_EXTRAS[db]) await c.command({ query: sql });
  }
  await c.close();
}

// ---------- MongoDB ----------
const mongoOpen = async () => { const { MongoClient } = require('mongodb'); const c = new MongoClient(`mongodb://${T.mongodb.host}:${T.mongodb.port}/?authSource=admin&directConnection=true`, { auth: { username: 'lookup', password: PW }, serverSelectionTimeoutMS: 5000 }); await c.connect(); await c.db('admin').command({ ping: 1 }); return c; };
async function countMongodb() {
  const c = await mongoOpen(); const out = {};
  try { for (const db of Object.keys(SCHEMA)) for (const t of Object.keys(SCHEMA[db])) out[`${db}.${t}`] = await c.db(db).collection(t).countDocuments(); } finally { await c.close(); }
  return out;
}
async function seedMongodb(data) {
  const { Decimal128, Long, UUID, Binary, ObjectId } = require('mongodb');
  const c = await waitFor('mongodb', mongoOpen);
  const OWN_ID = new Set(['orders', 'reviews', 'page_views']); // these get an ObjectId _id and keep the number as "id"
  // Typed values: money as Decimal128, big numbers as Long, dates as Date; empty values are left out of the document.
  const doc = (db, table, row, skip = []) => {
    const d = {};
    for (const [n, k] of Object.entries(SCHEMA[db][table])) {
      let v = conv('mongodb', k, row[n]);
      if (v == null || skip.includes(n)) continue;
      if (k.base === 'dec') v = Decimal128.fromString(v.toFixed(Number(k.args[1])));
      else if (k.base === 'bigint') v = Long.fromNumber(v);
      else if (k.base === 'uuid') v = new UUID(v);
      else if (k.base === 'bytes') v = new Binary(v);
      d[k.pk && !OWN_ID.has(table) ? '_id' : n] = v;
    }
    return d;
  };
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  const addresses = group(data.shop.addresses, 'customer_id'); const items = group(data.shop.order_items, 'order_id');
  const when = { orders: 'order_date', reviews: 'created_at', page_views: 'viewed_at' };
  for (const db of Object.keys(SCHEMA)) {
    const d = c.db(db);
    await d.dropDatabase();
    if (db === 'shop') {
      await d.createCollection('products', { validator: { $jsonSchema: { bsonType: 'object', required: ['sku', 'name', 'price', 'stock'],
        properties: { sku: { bsonType: 'string', pattern: '^SKU-[0-9]{6}$' }, name: { bsonType: 'string' }, price: { bsonType: 'decimal' }, stock: { bsonType: 'int', minimum: 0 }, tags: { bsonType: 'array', items: { bsonType: 'string' } } } } } });
    }
    for (const table of Object.keys(SCHEMA[db])) {
      const docs = data[db][table].map((r) => {
        const x = doc(db, table, r);
        if (OWN_ID.has(table)) return { _id: new ObjectId(Math.floor(r[when[table]] / 1000).toString(16).padStart(8, '0') + 'a1b2c3d4e5' + r.id.toString(16).padStart(6, '0')), ...x };
        return x;
      });
      if (table === 'customers') docs.forEach((x, i) => { x.addresses = (addresses.get(i + 1) || []).map((a) => doc('shop', 'addresses', a, ['id', 'customer_id'])); x.preferences = { language: pick(['en', 'ar', 'fr', 'de']), newsletter: !!x.marketing_opt_in }; });
      if (table === 'orders') docs.forEach((x, i) => { x.items = (items.get(i + 1) || []).map((it) => ({ ...doc('shop', 'order_items', it, ['id', 'order_id']), product_name: data.shop.products[it.product_id - 1].name })); });
      for (const part of chunks(docs, 10000)) await d.collection(table).insertMany(part, { ordered: false });
      log('mongodb', `${db}.${table}: ${docs.length} documents`);
    }
  }
  const shop = c.db('shop');
  await shop.collection('customers').createIndex({ email: 1 }, { unique: true });
  await shop.collection('customers').createIndex({ country_code: 1, vip: -1 });
  await shop.collection('products').createIndex({ sku: 1 }, { unique: true });
  await shop.collection('products').createIndex({ category_id: 1, price: -1 });
  await shop.collection('products').createIndex({ tags: 1 });
  await shop.collection('orders').createIndex({ order_number: 1 }, { unique: true });
  await shop.collection('orders').createIndex({ customer_id: 1, order_date: -1 });
  await shop.collection('orders').createIndex({ status: 1 }, { name: 'by_status' });
  await shop.collection('order_items').createIndex({ order_id: 1, line_no: 1 });
  await shop.collection('reviews').createIndex({ product_id: 1, rating: -1 });
  await shop.collection('payments').createIndex({ paid_at: 1 }, { sparse: true });
  await shop.createCollection('vip_customers', { viewOn: 'customers', pipeline: [{ $match: { vip: true } }, { $project: { first_name: 1, last_name: 1, email: 1, country_code: 1, loyalty_points: 1 } }] });
  await c.db('hr').collection('employees').createIndex({ employee_no: 1 }, { unique: true });
  await c.db('hr').collection('employees').createIndex({ department_id: 1, status: 1 });
  await c.db('hr').collection('attendance').createIndex({ employee_id: 1, work_date: -1 });
  await c.db('analytics').collection('page_views').createIndex({ session_id: 1 });
  await c.db('analytics').collection('page_views').createIndex({ viewed_at: -1 });
  await c.db('analytics').collection('sessions').createIndex({ session_uuid: 1 }, { unique: true });
  await c.close();
}

// ---------- Redis ----------
const redisOpen = async () => { const { RespClient } = require('../../src/main/db/redis/resp'); const c = await new RespClient().connect({ host: T.redis.host, port: T.redis.port, timeoutMs: 5000 }); await c.call('AUTH', 'lookup', PW); return c; };
async function countRedis() {
  const c = await redisOpen(); const out = {};
  try { for (const n of [0, 1, 2]) { await c.call('SELECT', n); out[`db${n}`] = await c.call('DBSIZE'); } } finally { await c.close(); }
  return out;
}
async function seedRedis(data) {
  const c = await waitFor('redis', redisOpen);
  let batch = []; let failed = 0; let firstError = null;
  const flush = async () => { const sent = batch; batch = []; for (const r of await c.pipeline(sent)) if (r instanceof Error) { failed++; firstError = firstError || r; } };
  const cmd = async (...args) => { batch.push(args); if (batch.length >= 4000) await flush(); };
  const useDb = async (n) => { await flush(); await c.call('SELECT', n); await c.call('FLUSHDB'); };
  const flat = (o) => Object.entries(o).filter(([, v]) => v != null).flatMap(([k, v]) => [k, v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  const { shop, hr, analytics } = data;

  // db0: the shop
  await useDb(0);
  let json = true;
  try { await c.call('JSON.SET', 'probe', '$', '1'); await c.call('DEL', 'probe'); } catch { json = false; log('redis', 'no JSON commands on this server: orders are stored as text'); }
  for (const x of shop.customers) await cmd('HSET', `customer:${x.id}`, ...flat({ name: `${x.first_name} ${x.last_name}`, email: x.email, phone: x.phone, country: x.country_code, points: x.loyalty_points, vip: x.vip ? 1 : 0, created_at: x.created_at }));
  for (const p of shop.products) {
    await cmd('HSET', `product:${p.id}`, ...flat({ sku: p.sku, name: p.name, price: p.price, stock: p.stock, category: p.category_id, attributes: p.attributes }));
    await cmd('SADD', `product:${p.id}:tags`, ...p.tags);
    await cmd('SET', `stock:${p.sku}`, p.stock);
    await cmd('SADD', `category:${p.category_id}:products`, p.id);
    for (const t of p.tags) await cmd('SADD', `tag:${t}`, p.id);
  }
  const spent = new Map(); const sold = new Map(); const lines = new Map();
  for (const i of shop.order_items) { sold.set(i.product_id, (sold.get(i.product_id) || 0) + i.quantity); if (!lines.has(i.order_id)) lines.set(i.order_id, []); lines.get(i.order_id).push({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total }); }
  for (const o of shop.orders) {
    const body = JSON.stringify({ id: o.id, number: o.order_number, customer_id: o.customer_id, status: o.status, date: o.order_date, currency: o.currency, total: o.total, shipping: { fee: o.shipping_fee, shipped_at: o.shipped_at }, items: lines.get(o.id), note: o.note });
    await cmd(...(json ? ['JSON.SET', `order:${o.id}`, '$', body] : ['SET', `order:${o.id}`, body]));
    await cmd('RPUSH', `customer:${o.customer_id}:orders`, o.id);
    if (o.status !== 'cancelled' && o.status !== 'refunded') spent.set(o.customer_id, r2((spent.get(o.customer_id) || 0) + o.total));
  }
  for (const part of chunks([...spent], 500)) await cmd('ZADD', 'leaderboard:customers:spent', ...part.flatMap(([id, v]) => [v, `customer:${id}`]));
  for (const part of chunks([...sold], 500)) await cmd('ZADD', 'leaderboard:products:sold', ...part.flatMap(([id, v]) => [v, `product:${id}`]));
  for (let i = 0; i < 3000; i++) { const id = int(1, 10000); await cmd('HSET', `cart:${id}`, ...Array.from({ length: int(1, 5) }, () => [`product:${int(1, 2000)}`, int(1, 4)]).flat()); await cmd('EXPIRE', `cart:${id}`, int(3600, 14 * 86400)); }
  for (let i = 0; i < 20000; i++) await cmd('SET', `session:${uuid()}`, JSON.stringify({ user: int(1, 10000), ip: `10.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`, csrf: hex(16) }), 'EX', i < 200 ? int(60, 900) : int(86400, 30 * 86400));
  for (const o of shop.orders.slice(-5000)) await cmd('XADD', 'events:orders', '*', 'order_id', o.id, 'status', o.status, 'total', o.total, 'currency', o.currency);
  for (const p of shop.payments.slice(-2000)) await cmd('XADD', 'events:payments', '*', 'payment_id', p.id, 'method', p.method, 'status', p.status, 'amount', p.amount);
  for (let i = 0; i < 500; i++) await cmd('RPUSH', 'queue:emails', JSON.stringify({ to: shop.customers[int(0, 9999)].email, template: pick(['welcome', 'order-shipped', 'reset-password', 'newsletter']), try: int(0, 2) }));
  for (const s of analytics.daily_stats) await cmd('HSET', `stats:daily:${s.stat_date}`, ...flat(s));
  for (const s of analytics.daily_stats.slice(-90)) await cmd('PFADD', `uv:${s.stat_date}`, ...Array.from({ length: 60 }, () => hex(12)));
  for (const s of analytics.daily_stats.slice(-30)) for (let i = 0; i < 150; i++) await cmd('SETBIT', `active-users:${s.stat_date}`, int(1, 10000), 1);
  for (const [path, title] of PATHS) await cmd('SET', `cache:page:${path}`, `<!doctype html>\n<html>\n<head><title>${title}</title></head>\n<body>\n${paragraph(40)}\n</body>\n</html>`, 'EX', 7 * 86400);
  for (let i = 1; i <= 100; i++) await cmd('SET', `cache:thumb:${i}`, Buffer.from(`89504e470d0a1a0a${hex(400)}`, 'hex')); // not text: shown as binary
  await cmd('HSET', 'config:app', 'name', 'Lookup Shop', 'currency', 'EGP', 'maintenance', 'off', 'support_email', 'help@example.com');
  await cmd('HSET', 'config:feature-flags', 'new-checkout', 'on', 'dark-mode', 'on', 'reviews-v2', 'off', 'ar-locale', 'beta');
  await cmd('SET', 'greeting:ar', 'مرحبا بالعالم'); await cmd('SET', 'greeting:ja', 'こんにちは世界'); await cmd('SET', 'greeting:emoji', '👋🌍');
  await cmd('SET', 'counter:orders', shop.orders.length); await cmd('SET', 'counter:visits', 1234567);
  await cmd('SET', 'a key with spaces', 'yes'); await cmd('SET', 'lock:reindex', hex(16), 'EX', 30 * 86400);

  // db1: hr
  await useDb(1);
  const paid = [];
  for (const e of hr.employees) {
    await cmd('HSET', `employee:${e.id}`, ...flat({ no: e.employee_no, name: `${e.first_name} ${e.last_name}`, email: e.email, department: e.department_id, job: e.job_id, salary: e.salary, status: e.status, hired: e.hire_date }));
    await cmd('SADD', `department:${e.department_id}:employees`, e.id);
    paid.push(e.salary, `employee:${e.id}`);
  }
  for (const part of chunks(paid, 1000)) await cmd('ZADD', 'salary:ranking', ...part);
  for (const a of hr.attendance) await cmd('RPUSH', `employee:${a.employee_id}:attendance`, `${a.work_date} ${a.status}${a.hours_worked == null ? '' : ` ${a.hours_worked}h`}`);
  for (const d of hr.departments) await cmd('HSET', `department:${d.id}`, ...flat(d));

  // db2: analytics
  await useDb(2);
  const perPath = new Map();
  for (const v of analytics.page_views) { const k = `pageviews:${day(v.viewed_at.getTime())}:${v.path.startsWith('/products/') ? '/products/*' : v.path.split('?')[0]}`; perPath.set(k, (perPath.get(k) || 0) + 1); }
  for (const [k, n] of perPath) await cmd('SET', k, n);
  for (const v of analytics.page_views.slice(-10000)) await cmd('XADD', 'events:pageviews', '*', 'session', v.session_id, 'path', v.path, 'ms', v.load_ms, 'status', v.status_code);
  const pages = new Map();
  for (const v of analytics.page_views) if (v.session_id > 15000) { if (!pages.has(v.session_id)) pages.set(v.session_id, []); pages.get(v.session_id).push(v.path); }
  for (const [id, list] of pages) await cmd('RPUSH', `session:${id}:pages`, ...list);
  for (const s of analytics.sessions.slice(-5000)) await cmd('ZADD', `sessions:by-duration:${s.device}`, s.duration_sec, s.session_uuid);
  await flush();
  if (failed) throw new Error(`${failed} commands failed, first: ${firstError.message}`);
  await c.call('SELECT', 0);
  await c.send(['BGSAVE']);
  const sizes = await countRedis();
  log('redis', Object.entries(sizes).map(([k, v]) => `${k}: ${v} keys`).join(', '));
  await c.close();
}

// ---------- run ----------
const ENGINES = {
  oracle: [seedOracle, countOracle], postgres: [seedPostgres, countPostgres], mysql: [seedMysql, countMysql],
  clickhouse: [seedClickhouse, countClickhouse], redis: [seedRedis, countRedis], mongodb: [seedMongodb, countMongodb],
};
async function main() {
  const args = process.argv.slice(2); const force = args.includes('--force'); const check = args.includes('--check');
  const picked = args.filter((a) => !a.startsWith('--'));
  const bad = picked.filter((a) => !ENGINES[a]);
  if (bad.length) throw new Error(`Unknown database: ${bad.join(', ')} (use ${Object.keys(ENGINES).join(', ')})`);
  const engines = picked.length ? picked : Object.keys(ENGINES);
  const data = build(); const want = expected(data);
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  if (check) {
    for (const e of engines) {
      try { const got = await ENGINES[e][1](); console.log(`[${e}] ${Object.entries(got).map(([k, v]) => `${k}=${v}`).join('  ')}`); } catch (err) { console.log(`[${e}] FAILED: ${String(err.message).split('\n')[0]}`); process.exitCode = 1; }
    }
    return;
  }
  log('seed', `${total} rows per database engine, ${Object.keys(want).length} tables`);
  // One engine at a time: slower, but it keeps memory low while six servers are running.
  for (const e of engines) {
    const t0 = Date.now(); const [load, count] = ENGINES[e];
    try {
      if (!force) {
        const got = await count().catch(() => null);
        if (got && (e === 'redis' ? got.db0 > 0 && got.db1 > 0 && got.db2 > 0 : same(got, want))) { log(e, 'already filled, skipped (use --force to load again)'); continue; }
      }
      await load(data);
      log(e, `done in ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (err) { log(e, `FAILED: ${err.stack || err.message}`); process.exitCode = 1; }
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
