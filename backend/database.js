import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';

// DB helper exports
export function getDbPath() {
  const dir = process.env.COACHING_DATA_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) { }
  }
  return path.join(dir, 'coaching.db');
}

export function getDbDir() {
  const dir = process.env.COACHING_DATA_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) { }
  }
  return dir;
}

export const DB_PATH = getDbPath();
export const DB_DIR = getDbDir();

let SQL = null;
let sqlDb = null;

async function initSql() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  if (!sqlDb) {
    const dbPath = getDbPath();
    if (fs.existsSync(dbPath)) {
      const filebuffer = fs.readFileSync(dbPath);
      sqlDb = new SQL.Database(filebuffer);
    } else {
      sqlDb = new SQL.Database();
    }
  }
}

function saveDb() {
  if (sqlDb) {
    const data = sqlDb.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(getDbPath(), buffer);
  }
}

// Wrapper to mimic better-sqlite3 sync API using sql.js
class SqlJsSyncAdapter {
  constructor() { }

  exec(sql) {
    if (!sqlDb) throw new Error('Database not initialized');
    sqlDb.exec(sql);
    saveDb();
  }

  prepare(sql) {
    if (!sqlDb) throw new Error('Database not initialized');
    const self = this;
    return {
      run(...params) {
        const stmt = sqlDb.prepare(sql);
        try {
          stmt.bind(params);
          stmt.step();
          // Get last insert rowid
          const res = sqlDb.exec("SELECT last_insert_rowid() as id;");
          const lastId = res.length > 0 && res[0].values.length > 0 ? res[0].values[0][0] : 0;
          stmt.free();
          saveDb();
          return { lastInsertRowid: lastId };
        } catch (err) {
          stmt.free();
          throw err;
        }
      },
      get(...params) {
        const stmt = sqlDb.prepare(sql);
        try {
          stmt.bind(params);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
          }
          stmt.free();
          return undefined;
        } catch (err) {
          stmt.free();
          throw err;
        }
      },
      all(...params) {
        const stmt = sqlDb.prepare(sql);
        try {
          stmt.bind(params);
          const results = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        } catch (err) {
          stmt.free();
          throw err;
        }
      }
    };
  }
}

export const db = new SqlJsSyncAdapter();

// Initialize schema
export async function initDatabase() {
  await initSql();
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS academic_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      academic_year_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      class_number INTEGER NOT NULL,
      monthly_fee REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
      UNIQUE(academic_year_id, class_number)
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      academic_year_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      roll_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      father_name TEXT,
      mother_name TEXT,
      phone TEXT NOT NULL,
      address TEXT,
      admission_date TEXT NOT NULL,
      status TEXT DEFAULT 'Active',
      photo_url TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      UNIQUE(academic_year_id, class_id, roll_number)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      academic_year_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      year INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      payment_time TEXT NOT NULL,
      payment_method TEXT DEFAULT 'Cash',
      receipt_no TEXT UNIQUE NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT,
      FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      UNIQUE(student_id, month, academic_year_id)
    );

    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      expense_date TEXT NOT NULL,
      expense_time TEXT NOT NULL,
      voucher_no TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      per_class_rate REAL DEFAULT 0,
      per_khata_rate REAL DEFAULT 0,
      per_guard_rate REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS teacher_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      activity_date TEXT NOT NULL,
      classes_taken INTEGER DEFAULT 0,
      khatas_checked INTEGER DEFAULT 0,
      guard_duties INTEGER DEFAULT 0,
      per_class_rate REAL DEFAULT 0,
      per_khata_rate REAL DEFAULT 0,
      per_guard_rate REAL DEFAULT 0,
      class_earnings REAL DEFAULT 0,
      khata_earnings REAL DEFAULT 0,
      guard_earnings REAL DEFAULT 0,
      daily_total REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS teacher_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      payment_date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );
  `);

  try {
    db.prepare("UPDATE students SET status = 'Active' WHERE status != 'Active'").run();
  } catch (e) {
    // ignore if table doesn't exist yet
  }

  seedDefaultDataIfEmpty();
}

export function getMonthsList() {
  return [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
}

export function seedDefaultDataIfEmpty(force = false) {
  const ayCount = db.prepare('SELECT COUNT(*) as count FROM academic_years').get();
  const studentCount = db.prepare('SELECT COUNT(*) as count FROM students').get();
  if (ayCount && ayCount.count > 0 && studentCount && studentCount.count > 0 && !force) {
    return;
  }

  // Clear existing if re-seeding or partially initialized
  db.exec(`
    DELETE FROM payments;
    DELETE FROM expenses;
    DELETE FROM students;
    DELETE FROM classes;
    DELETE FROM academic_years;
    DELETE FROM expense_categories;
    DELETE FROM settings;
  `);

  // 1. Academic Year 2026
  db.prepare(`
    INSERT INTO academic_years (year, name, start_date, end_date, is_active)
    VALUES (?, ?, ?, ?, ?)
  `).run(2026, 'Academic Year 2026', '2026-01-01', '2026-12-31', 1);

  const ay2026 = db.prepare('SELECT id FROM academic_years WHERE year = 2026').get();

  // 2. Classes for 2026
  const classesData = [
    { name: 'Class 3', number: 3, fee: 800 },
    { name: 'Class 4', number: 4, fee: 900 },
    { name: 'Class 5', number: 5, fee: 1000 },
    { name: 'Class 6', number: 6, fee: 1100 },
    { name: 'Class 7', number: 7, fee: 1200 },
  ];

  const classInsert = db.prepare(`
    INSERT INTO classes (academic_year_id, name, class_number, monthly_fee)
    VALUES (?, ?, ?, ?)
  `);

  for (const c of classesData) {
    classInsert.run(ay2026.id, c.name, c.number, c.fee);
  }

  // 3. Expense Categories
  const categories = [
    'Teacher Salary',
    'Rent',
    'Electricity',
    'Internet',
    'Stationery',
    'Furniture',
    'Printing',
    'Marketing',
    'Other'
  ];

  const catInsert = db.prepare('INSERT INTO expense_categories (name, is_default) VALUES (?, 1)');
  for (const cat of categories) {
    catInsert.run(cat);
  }

  // 4. Populate Students matching design targets (185 students in total: 25 in Cls 3, 31 in Cls 4, 35 in Cls 5, 42 in Cls 6, 52 in Cls 7)
  const classesInDb = db.prepare('SELECT * FROM classes WHERE academic_year_id = ? ORDER BY class_number ASC').all(ay2026.id);

  const namesList = [
    { name: 'Rahim Ahmed', father: 'Kamal Ahmed', mother: 'Nasreen Sultana', phone: '01712-345678', address: 'House 42, Road 7, Dhanmondi, Dhaka' },
    { name: 'Anika Tabassum', father: 'Farid Uddin', mother: 'Shireen Akhter', phone: '01823-456789', address: 'Plot 12, Block C, Mirpur, Dhaka' },
    { name: 'Tahmid Alom', father: 'Alomgir Hossain', mother: 'Parveen Begum', phone: '01711-889922', address: 'Lane 4, Mohammadpur, Dhaka' },
    { name: 'Sadia Afrin', father: 'Mustafizur Rahman', mother: 'Lutfun Nahar', phone: '01912-334455', address: 'Road 11, Banani, Dhaka' },
    { name: 'Samiul Islam', father: 'Jahangir Alam', mother: 'Rokeya Begum', phone: '01911-223344', address: 'Sector 4, Uttara, Dhaka' },
    { name: 'Karim Hasan', father: 'Abdul Hasan', mother: 'Nazma Khatun', phone: '01822-449102', address: 'Green Road, Farmgate, Dhaka' },
    { name: 'Nusrat Jahan', father: 'Tariqul Islam', mother: 'Munira Parveen', phone: '01688-990011', address: 'Shantinagar, Dhaka' },
    { name: 'Zubair Rahman', father: 'Habibur Rahman', mother: 'Fatema Tuz Zohra', phone: '01755-443322', address: 'Lalmatia, Dhaka' },
    { name: 'Hasan Mahmud', father: 'Mahmudur Rahman', mother: 'Salma Begum', phone: '01933-772810', address: 'Badda, Dhaka' },
    { name: 'Mehnaz Chowdhury', father: 'Kaiser Chowdhury', mother: 'Nazma Begum', phone: '01844-667788', address: 'Kakrail, Dhaka' },
    { name: 'Shahriar Kabir', father: 'Golam Kabir', mother: 'Salma Khatun', phone: '01933-778899', address: 'Malibagh, Dhaka' },
    { name: 'Fariha Noor', father: 'Noor Mohammad', mother: 'Tahmina Begum', phone: '01722-889900', address: 'Gulshan 1, Dhaka' },
    { name: 'Tanvir Hasan', father: 'Monirul Hasan', mother: 'Laila Arjumand', phone: '01819-334455', address: 'Khilgaon, Dhaka' },
    { name: 'Mahir Faisal', father: 'Abu Faisal', mother: 'Rehana Sultana', phone: '01734-556677', address: 'Motijheel, Dhaka' },
    { name: 'Fahim Khan', father: 'Zahir Khan', mother: 'Shamima Nasrin', phone: '01678-223311', address: 'Old Dhaka, Sadarghat' },
    { name: 'Sumaiya Akter', father: 'Enamul Haque', mother: 'Jannatul Ferdous', phone: '01815-998877', address: 'Rampura, Dhaka' },
    { name: 'Tanvir Islam', father: 'Rafiqul Islam', mother: 'Hosne Ara', phone: '01715-441199', address: 'Panthapath, Dhaka' }
  ];

  const studentInsert = db.prepare(`
    INSERT INTO students (
      academic_year_id, class_id, roll_number, name, father_name, mother_name,
      phone, address, admission_date, status, photo_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const studentCountMap = {
    3: 25,
    4: 31,
    5: 35,
    6: 42,
    7: 52
  };

  let receiptSeq = 9000;
  const payInsert = db.prepare(`
    INSERT INTO payments (
      student_id, academic_year_id, class_id, month, year, amount,
      payment_date, payment_time, payment_method, receipt_no, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const cls of classesInDb) {
    const targetCount = studentCountMap[cls.class_number] || 30;
    const baseRoll = cls.class_number * 100;

    for (let i = 1; i <= targetCount; i++) {
      const roll = baseRoll + i;
      const personTemplate = namesList[(roll + i) % namesList.length];
      const isSpecificRahim = (cls.class_number === 5 && roll === 501) || (cls.class_number === 5 && roll === 508);
      const studentName = isSpecificRahim ? 'Rahim Ahmed' : (i <= namesList.length ? namesList[i - 1].name : `${personTemplate.name} ${i}`);
      const isInactive = (cls.class_number === 6 && roll === 607);
      const admMonth = (i % 8 === 0) ? '03' : (i % 12 === 0 ? '04' : '01');
      const admDay = String(1 + (i % 25)).padStart(2, '0');
      const admissionDate = `2026-${admMonth}-${admDay}`;

      const photo = isSpecificRahim
        ? 'https://lh3.googleusercontent.com/aida-public/AB6AXuBZ3K4MozieIIKDvxjzDoCtiocDO8_JoyBI8BkPF7wqalh7i4kPRaf_fYy80zRy_4RZ0bmWAto6ZPk7GZ3LUzSXUapwQjs00def3OOexTzXowoVXzbDNSopN9VvWaE3QHIUeTj59o-A5HZpCdS7NHuzSSecm17MEMPM2_ChrPVJ3GzXLYZn_r8T0c12RW1K9r-u-v08klVLhqnKwoxF0JxKjHjMFkiTXyK0GiRrXVIjkKn8HYkQtVmV'
        : null;

      const res = studentInsert.run(
        ay2026.id,
        cls.id,
        roll,
        studentName,
        personTemplate.father,
        personTemplate.mother,
        personTemplate.phone,
        personTemplate.address,
        admissionDate,
        'Active',
        photo
      );

      const studentId = Number(res.lastInsertRowid);

      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
      const admMonthNum = parseInt(admMonth, 10);

      const isDueSep = (cls.class_number === 5 && (roll === 501 || roll === 507 || roll === 512 || roll === 515)) ||
        (cls.class_number === 3 && (roll === 302 || roll === 305)) ||
        (cls.class_number === 4 && (roll === 412)) ||
        (cls.class_number === 6 && (roll === 607 || roll === 614)) ||
        (cls.class_number === 7 && (roll === 710));

      const isDueAug = (cls.class_number === 5 && roll === 512);

      months.forEach((mName, mIdx) => {
        const monthNum = mIdx + 1;
        if (monthNum < admMonthNum) return;

        if (mName === 'August' && isDueAug) return;
        if (mName === 'September') {
          if (isDueSep) return;
          if ((roll * 7 + mIdx) % 10 > 7) return;
        }

        receiptSeq++;
        const payDay = String(3 + ((roll + mIdx) % 24)).padStart(2, '0');
        const payDate = `2026-${String(monthNum).padStart(2, '0')}-${payDay}`;
        const payTime = `${String(9 + (roll % 10)).padStart(2, '0')}:${String(10 + (roll % 45)).padStart(2, '0')} AM`;
        const method = (roll % 3 === 0) ? 'bKash' : ((roll % 7 === 0) ? 'Nagad' : 'Cash');

        payInsert.run(
          studentId,
          ay2026.id,
          cls.id,
          mName,
          2026,
          cls.monthly_fee,
          payDate,
          payTime,
          method,
          `REC-2026-${String(receiptSeq).padStart(4, '0')}`,
          'Monthly tuition fee'
        );
      });
    }
  }

  const teacherCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Teacher Salary'").get();
  const rentCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Rent'").get();
  const elecCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Electricity'").get();
  const netCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Internet'").get();
  const statCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Stationery'").get();

  const expInsert = db.prepare(`
    INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  expInsert.run(elecCat.id, 1500, 'Electricity Bill • Sep Meter #4022', '2026-09-18', '09:15 AM', 'V-102');
  expInsert.run(statCat.id, 500, 'Whiteboard markers and lecture notes paper', '2026-09-18', '11:45 AM', 'V-103');
  expInsert.run(teacherCat.id, 8000, 'Teacher Salary • Mathematics Dept', '2026-09-17', '02:00 PM', 'V-101');
  expInsert.run(rentCat.id, 25000, 'Coaching Center Premises Monthly Rent - September', '2026-09-01', '10:00 AM', 'V-098');
  expInsert.run(teacherCat.id, 8000, 'English Teacher - September Salary', '2026-09-01', '11:30 AM', 'V-099');
  expInsert.run(teacherCat.id, 7500, 'Science Teacher - September Salary', '2026-09-01', '03:15 PM', 'V-100');
  expInsert.run(netCat.id, 1200, 'High Speed Fiber Broadband - September', '2026-09-05', '04:00 PM', 'V-104');

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('active_academic_year', '2026');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('center_name', 'Coaching Center Management System');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('phone', '+880 1712-345678');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('currency_symbol', '৳');
}

export function getNextRollNumber(academicYearId, classId) {
  const cls = db.prepare('SELECT class_number FROM classes WHERE id = ?').get(classId);
  if (!cls) {
    throw new Error('Class not found');
  }

  const row = db.prepare(`
    SELECT MAX(roll_number) as max_roll
    FROM students
    WHERE academic_year_id = ? AND class_id = ?
  `).get(academicYearId, classId);

  if (!row || row.max_roll === null) {
    return cls.class_number * 100 + 1;
  }
  return row.max_roll + 1;
}
