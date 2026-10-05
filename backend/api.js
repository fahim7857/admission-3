import express from 'express';
import { db, getNextRollNumber, seedDefaultDataIfEmpty, getMonthsList, getDbPath, getDbDir, initDatabase } from './database.js';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminSupabaseRequest,
  authenticateRequest,
  getPublicSupabaseConfig,
  publicSupabaseRequest,
  requireDeletePermission,
  requireSuperAdmin
} from './auth.js';

export const apiRouter = express.Router();

const MONTHS = getMonthsList();

// Public Supabase bootstrap and staff application endpoints.
// Every existing application API route is protected immediately below these.
apiRouter.get('/auth/config', (req, res) => {
  const config = getPublicSupabaseConfig();
  if (!config.url || !config.anonKey) {
    return res.status(503).json({
      success: false,
      error: 'Authentication is not configured',
      message: 'The application administrator must configure Supabase before sign-in can be used.'
    });
  }
  return res.json({ success: true, data: config });
});

apiRouter.post('/staff-applications', async (req, res) => {
  const fullName = String(req.body?.full_name || req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const notes = String(req.body?.notes || '').trim() || null;
  const userId = req.body?.user_id || null;

  if (!fullName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      error: 'Name and a valid email address are required'
    });
  }

  try {
    // Idempotency guard: never create a second pending application for the same email.
    const existing = await adminSupabaseRequest(
      `/rest/v1/staff_applications?select=id&email=eq.${encodeURIComponent(email)}&status=eq.pending&limit=1`,
      { method: 'GET' }
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(201).json({
        success: true,
        message: 'Staff application submitted for review.'
      });
    }

    const payload = {
      full_name: fullName,
      email,
      notes,
      status: 'pending'
    };
    if (userId) payload.user_id = userId;

    // Single INSERT. There is no fallback INSERT anywhere in this handler.
    await adminSupabaseRequest('/rest/v1/staff_applications', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });

    return res.status(201).json({
      success: true,
      message: 'Staff application submitted for review.'
    });
  } catch (error) {
    console.error('Staff application submission failed:', error);
    return res.status(error.message.startsWith('Supabase is not configured.') ? 503 : 500).json({
      success: false,
      error: 'Unable to submit staff application',
      message: error.message.startsWith('Supabase is not configured.')
        ? 'The application administrator must configure Supabase before applications can be submitted.'
        : 'Please try again later.'
    });
  }
});

// Backend authentication is the source of truth for every existing SQLite API.
apiRouter.use(authenticateRequest);

apiRouter.get('/auth/me', (req, res) => {
  res.json({
    success: true,
    data: {
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        name: req.auth.user.user_metadata?.full_name || req.auth.user.user_metadata?.name || ''
      },
      role: req.auth.role
    }
  });
});

// ----------------------------------------------------
// SUPER ADMIN STAFF MANAGEMENT
// ----------------------------------------------------
function serviceErrorStatus(error) {
  return error.message.startsWith('Supabase is not configured.') ? 503 : 500;
}

async function findAuthUserByEmail(email) {
  const result = await adminSupabaseRequest('/auth/v1/admin/users?page=1&per_page=1000', { method: 'GET' });
  const users = Array.isArray(result) ? result : result?.users || [];
  return users.find(user => String(user.email || '').toLowerCase() === email.toLowerCase()) || null;
}

async function getStaffApplication(id) {
  const rows = await adminSupabaseRequest(
    `/rest/v1/staff_applications?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows[0] : null;
}

apiRouter.get('/admin/staff-applications', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await adminSupabaseRequest(
      '/rest/v1/staff_applications?select=*&order=created_at.desc',
      { method: 'GET' }
    );
    return res.json({ success: true, data: Array.isArray(rows) ? rows : [] });
  } catch (error) {
    console.error('Staff application list failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to load staff applications'
    });
  }
});

apiRouter.post('/admin/staff-applications/:id/approve', requireSuperAdmin, async (req, res) => {
  const applicationId = req.params.id;

  try {
    const application = await getStaffApplication(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, error: 'Staff application not found' });
    }
    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `This application is already ${application.status}.`
      });
    }

    let user = await findAuthUserByEmail(application.email);
    if (!user) {
      const invitation = await adminSupabaseRequest('/auth/v1/invite', {
        method: 'POST',
        body: JSON.stringify({
          email: application.email,
          data: { full_name: application.full_name }
        })
      });
      user = invitation?.user || invitation;
    }

    if (!user?.id) {
      throw new Error('Supabase did not return an Auth user for the approved application.');
    }

    // Admin approval replaces email verification: mark the user's email as confirmed
    // so an approved staff member can sign in without clicking a confirmation link.
    if (!user.email_confirmed_at && !user.confirmed_at) {
      await adminSupabaseRequest(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ email_confirm: true })
      });
    }

    const existingRoles = await adminSupabaseRequest(
      `/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
      { method: 'GET' }
    );
    const existingRole = Array.isArray(existingRoles) ? existingRoles[0]?.role : null;
    if (existingRole !== 'super_admin') {
      await adminSupabaseRequest('/rest/v1/user_roles', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: user.id, role: 'staff' })
      });
    }

    await adminSupabaseRequest(
      `/rest/v1/staff_applications?id=eq.${encodeURIComponent(applicationId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'approved',
          user_id: user.id,
          reviewed_by: req.auth.user.id,
          reviewed_at: new Date().toISOString()
        })
      }
    );

    return res.json({
      success: true,
      message: existingRole === 'super_admin'
        ? 'Application approved; the existing Super Admin role was preserved.'
        : 'Application approved and Staff access assigned.'
    });
  } catch (error) {
    console.error('Staff application approval failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to approve staff application',
      message: error.message.includes('invite')
        ? 'The application was not approved because the Supabase invitation could not be created.'
        : undefined
    });
  }
});

apiRouter.post('/admin/staff-applications/:id/reject', requireSuperAdmin, async (req, res) => {
  const applicationId = req.params.id;

  try {
    const application = await getStaffApplication(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, error: 'Staff application not found' });
    }
    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `This application is already ${application.status}.`
      });
    }

    await adminSupabaseRequest(
      `/rest/v1/staff_applications?id=eq.${encodeURIComponent(applicationId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'rejected',
          reviewed_by: req.auth.user.id,
          reviewed_at: new Date().toISOString()
        })
      }
    );

    return res.json({ success: true, message: 'Staff application rejected.' });
  } catch (error) {
    console.error('Staff application rejection failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to reject staff application'
    });
  }
});

// Dhaka, Bangladesh (UTC+6) Timezone Helpers
export function getDhakaDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

export function getDhakaTime(d = new Date()) {
  return d.toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: true });
}

export function getDateRangeContext(clientDate) {
  const today = (clientDate && /^\d{4}-\d{2}-\d{2}$/.test(clientDate))
    ? clientDate
    : getDhakaDate();

  const [tYear, tMonth, tDay] = today.split('-').map(Number);
  const todayDateObj = new Date(tYear, tMonth - 1, tDay);

  // Week range: Monday to Sunday of the current week containing today
  const dayOfWeek = todayDateObj.getDay(); // 0 is Sunday, 1 is Monday...
  const diffToMonday = todayDateObj.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const mondayObj = new Date(tYear, tMonth - 1, diffToMonday);
  const sundayObj = new Date(tYear, tMonth - 1, diffToMonday + 6);

  const weekStart = `${mondayObj.getFullYear()}-${String(mondayObj.getMonth() + 1).padStart(2, '0')}-${String(mondayObj.getDate()).padStart(2, '0')}`;
  const weekEnd = `${sundayObj.getFullYear()}-${String(sundayObj.getMonth() + 1).padStart(2, '0')}-${String(sundayObj.getDate()).padStart(2, '0')}`;

  // Month range: 1st of the month to last day of month
  const monthStart = `${tYear}-${String(tMonth).padStart(2, '0')}-01`;
  const lastDayOfMonth = new Date(tYear, tMonth, 0).getDate();
  const monthEnd = `${tYear}-${String(tMonth).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;

  return {
    today,
    weekStart,
    weekEnd,
    monthStart,
    monthEnd,
    year: tYear
  };
}

export function getCurrentMonth() {
  const months = getMonthsList();
  const dhakaDateStr = getDhakaDate();
  const mIndex = parseInt(dhakaDateStr.split('-')[1], 10) - 1;
  return months[mIndex] || months[new Date().getMonth()];
}

export function getCurrentMonthIndex() {
  const dhakaDateStr = getDhakaDate();
  return parseInt(dhakaDateStr.split('-')[1], 10) - 1;
}

export function getActiveAcademicYear() {
  const row = db.prepare('SELECT * FROM academic_years WHERE is_active = 1 ORDER BY year DESC LIMIT 1').get();
  if (row) return row;
  const fallback = db.prepare('SELECT * FROM academic_years ORDER BY year DESC LIMIT 1').get();
  if (fallback) return fallback;
  return { id: 1, year: new Date().getFullYear(), name: `Academic Year ${new Date().getFullYear()}`, is_active: 1 };
}

export function resolveAcademicYear(requestedId) {
  if (requestedId !== undefined && requestedId !== null && requestedId !== '') {
    const id = parseInt(requestedId, 10);
    if (!isNaN(id) && id > 0) {
      const row = db.prepare('SELECT * FROM academic_years WHERE id = ?').get(id);
      if (row) return row;
    }
  }
  return getActiveAcademicYear();
}

function getActiveAcademicYearId() {
  return getActiveAcademicYear().id;
}

// ----------------------------------------------------
// ACADEMIC YEARS
// ----------------------------------------------------
apiRouter.get('/academic-years', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM academic_years ORDER BY year DESC').all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/academic-years/active', (req, res) => {
  try {
    const activeYear = getActiveAcademicYear();
    res.json({ success: true, data: activeYear });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/academic-years', requireSuperAdmin, (req, res) => {
  try {
    const { year, name, start_date, end_date, copy_classes_from } = req.body;
    if (!year || !name) {
      return res.status(400).json({ success: false, error: 'Year and name are required' });
    }

    const yearNum = parseInt(year, 10);
    const existing = db.prepare('SELECT id FROM academic_years WHERE year = ?').get(yearNum);
    if (existing) {
      return res.status(400).json({ success: false, error: `Academic Year ${yearNum} already exists` });
    }

    const startDate = start_date || `${yearNum}-01-01`;
    const endDate = end_date || `${yearNum}-12-31`;

    const insertYear = db.prepare(`
      INSERT INTO academic_years (year, name, start_date, end_date, is_active)
      VALUES (?, ?, ?, ?, 0)
    `);
    const result = insertYear.run(yearNum, name, startDate, endDate);
    const newYearId = Number(result.lastInsertRowid);

    // Fresh Class Structure for the new academic year
    // Do NOT copy any students, rolls, payments, or fee receipts!
    const sourceYearId = copy_classes_from ? parseInt(copy_classes_from, 10) : getActiveAcademicYearId();
    let sourceClasses = db.prepare('SELECT name, class_number, monthly_fee FROM classes WHERE academic_year_id = ? ORDER BY class_number ASC').all(sourceYearId);

    if (!sourceClasses || sourceClasses.length === 0) {
      sourceClasses = [
        { name: 'Class 3', class_number: 3, monthly_fee: 800 },
        { name: 'Class 4', class_number: 4, monthly_fee: 900 },
        { name: 'Class 5', class_number: 5, monthly_fee: 1000 },
        { name: 'Class 6', class_number: 6, monthly_fee: 1100 },
        { name: 'Class 7', class_number: 7, monthly_fee: 1200 }
      ];
    }

    const classInsert = db.prepare(`
      INSERT INTO classes (academic_year_id, name, class_number, monthly_fee)
      VALUES (?, ?, ?, ?)
    `);

    for (const c of sourceClasses) {
      classInsert.run(newYearId, c.name, c.class_number, c.monthly_fee);
    }

    res.json({
      success: true,
      message: `Fresh Academic Year ${yearNum} created with clean class structure`,
      data: { id: newYearId, year: yearNum, name }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/academic-years/:id/activate', requireSuperAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const targetYear = db.prepare('SELECT * FROM academic_years WHERE id = ?').get(id);
    if (!targetYear) {
      return res.status(404).json({ success: false, error: 'Academic year not found' });
    }

    db.exec('BEGIN TRANSACTION;');
    try {
      db.prepare('UPDATE academic_years SET is_active = 0').run();
      db.prepare('UPDATE academic_years SET is_active = 1 WHERE id = ?').run(id);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('active_academic_year', String(targetYear.year));
      db.exec('COMMIT;');
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }

    res.json({ success: true, message: `Academic Year ${targetYear.year} is now active`, data: targetYear });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/academic-years/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const yearRow = db.prepare('SELECT * FROM academic_years WHERE id = ?').get(id);
    if (!yearRow) {
      return res.status(404).json({ success: false, error: 'Academic year not found' });
    }

    const totalYears = db.prepare('SELECT COUNT(*) as count FROM academic_years').get().count;
    if (totalYears <= 1) {
      return res.status(400).json({ success: false, error: 'Cannot delete the only academic year in the system' });
    }

    // Clean up all associated payments, students, and classes for this academic year
    db.prepare('DELETE FROM payments WHERE academic_year_id = ?').run(id);
    db.prepare('DELETE FROM students WHERE academic_year_id = ?').run(id);
    db.prepare('DELETE FROM classes WHERE academic_year_id = ?').run(id);
    db.prepare('DELETE FROM academic_years WHERE id = ?').run(id);

    // If active year was deleted, activate the latest remaining year
    if (yearRow.is_active) {
      const remaining = db.prepare('SELECT id, year FROM academic_years ORDER BY year DESC LIMIT 1').get();
      if (remaining) {
        db.prepare('UPDATE academic_years SET is_active = 1 WHERE id = ?').run(remaining.id);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('active_academic_year', String(remaining.year));
      }
    }

    res.json({
      success: true,
      message: `Academic Year ${yearRow.year} and all its associated data were deleted successfully`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// CLASSES
// ----------------------------------------------------
apiRouter.get('/classes', (req, res) => {
  try {
    const academicYearId = resolveAcademicYear(req.query.academic_year_id).id;
    const classes = db.prepare(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) as student_count
      FROM classes c
      WHERE c.academic_year_id = ?
      ORDER BY c.class_number ASC
    `).all(academicYearId);
    res.json({ success: true, data: classes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/classes', (req, res) => {
  try {
    const { academic_year_id, name, class_number, monthly_fee } = req.body;
    const ayId = resolveAcademicYear(academic_year_id).id;
    const cNum = parseInt(class_number, 10);
    const fee = parseFloat(monthly_fee);

    if (!name || isNaN(cNum) || isNaN(fee) || fee <= 0) {
      return res.status(400).json({ success: false, error: 'Valid name, class number, and positive monthly fee required' });
    }

    const insert = db.prepare(`
      INSERT INTO classes (academic_year_id, name, class_number, monthly_fee)
      VALUES (?, ?, ?, ?)
    `);
    const resRow = insert.run(ayId, name, cNum, fee);
    res.json({ success: true, data: { id: Number(resRow.lastInsertRowid) } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.put('/classes/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, monthly_fee } = req.body;
    const fee = parseFloat(monthly_fee);
    if (isNaN(fee) || fee <= 0) {
      return res.status(400).json({ success: false, error: 'Monthly fee must be positive' });
    }

    const currentClass = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    if (!currentClass) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }
    const updatedName = (name && name.trim()) ? name.trim() : currentClass.name;

    db.prepare('UPDATE classes SET name = ?, monthly_fee = ? WHERE id = ?').run(updatedName, fee, id);
    res.json({ success: true, message: 'Class updated' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/classes/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid class ID' });
    }

    const cls = db.prepare('SELECT id, name, class_number FROM classes WHERE id = ?').get(id);
    if (!cls) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }

    const isTotalDatabase = req.query.total_database === 'true' || req.query.scope === 'total';

    let targetClasses = [cls];
    if (isTotalDatabase) {
      targetClasses = db.prepare(
        'SELECT id, name FROM classes WHERE class_number = ? OR LOWER(name) = LOWER(?)'
      ).all(cls.class_number, cls.name);
    }

    // Removed manual BEGIN/COMMIT since sql.js adapter saves per statement / auto-commits synchronously
    try {
      let totalStudentsDeleted = 0;
      let totalPaymentsDeleted = 0;

      for (const target of targetClasses) {
        // Count students
        const stCountRow = db.prepare('SELECT COUNT(*) as c FROM students WHERE class_id = ?').get(target.id);
        const stCount = stCountRow ? stCountRow.c : 0;
        totalStudentsDeleted += stCount;

        // Delete associated payments first
        const payRes = db.prepare(`
          DELETE FROM payments 
          WHERE class_id = ? 
             OR student_id IN (SELECT id FROM students WHERE class_id = ?)
        `).run(target.id, target.id);
        totalPaymentsDeleted += (payRes && payRes.changes ? payRes.changes : 0);

        // Delete students in this class
        db.prepare('DELETE FROM students WHERE class_id = ?').run(target.id);

        // Delete the class record itself
        db.prepare('DELETE FROM classes WHERE id = ?').run(target.id);
      }

      const scopeNotice = isTotalDatabase
        ? 'from the total database (across all academic years)'
        : 'from the database';

      res.json({
        success: true,
        message: `Class "${cls.name}" was permanently deleted ${scopeNotice} along with ${totalStudentsDeleted} enrolled student(s) and ${totalPaymentsDeleted} payment record(s).`,
        data: {
          targetClassesCount: targetClasses.length,
          totalStudentsDeleted,
          totalPaymentsDeleted
        }
      });
    } catch (innerErr) {
      throw innerErr;
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// STUDENTS & AUTOMATIC ROLL
// ----------------------------------------------------
apiRouter.get('/students/next-roll', (req, res) => {
  try {
    const classId = parseInt(req.query.class_id, 10);
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;

    if (isNaN(classId)) {
      return res.status(400).json({ success: false, error: 'class_id is required' });
    }

    const nextRoll = getNextRollNumber(ayId, classId);
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);

    res.json({
      success: true,
      nextRoll,
      classFee: cls?.monthly_fee ?? 1000,
      className: cls?.name ?? ''
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.get('/students', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    const classFilter = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const statusFilter = req.query.status || 'all';
    const paymentFilter = req.query.payment_status || 'all';
    const search = (req.query.search || '').trim().toLowerCase();
    const currentMonth = (req.query.month) || getCurrentMonth();

    let query = `
      SELECT s.*, c.name as class_name, c.class_number, c.monthly_fee, ay.year as academic_year,
        EXISTS (
          SELECT 1 FROM payments p 
          WHERE p.student_id = s.id 
            AND p.academic_year_id = s.academic_year_id 
            AND p.month = ?
        ) as is_paid_current_month
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE s.academic_year_id = ?
    `;
    const params = [currentMonth, ayId];

    if (classFilter) {
      query += ' AND s.class_id = ?';
      params.push(classFilter);
    }

    if (statusFilter !== 'all') {
      query += ' AND s.status = ?';
      params.push(statusFilter);
    }

    if (search) {
      let searchRoll = null;
      const cleanSearch = search.replace(/^#/, '').trim();
      const stuMatch = cleanSearch.match(/^stu[-_]?(?:20\d{2})?[-_]?0*(\d+)$/i) || cleanSearch.match(/^stu[-_]?0*(\d+)$/i);
      if (stuMatch) {
        searchRoll = parseInt(stuMatch[1], 10);
      } else {
        const rawDigits = cleanSearch.replace(/[^0-9]/g, '');
        if (rawDigits.length > 0 && rawDigits.length <= 6) {
          searchRoll = parseInt(rawDigits, 10);
        }
      }

      query += ` AND (
        LOWER(s.name) LIKE ? OR 
        CAST(s.roll_number AS TEXT) LIKE ? OR 
        s.phone LIKE ? OR 
        LOWER(s.father_name) LIKE ? OR
        LOWER(s.mother_name) LIKE ? OR
        ('stu-' || ay.year || '-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || s.roll_number) LIKE ?
      `;
      const wild = `%${cleanSearch}%`;
      params.push(wild, wild, wild, wild, wild, wild, wild, wild);

      if (searchRoll !== null) {
        query += ` OR s.roll_number = ?`;
        params.push(searchRoll);
      }
      query += ` )`;
    }

    query += ' ORDER BY c.class_number ASC, s.roll_number ASC';

    const rows = db.prepare(query).all(...params);

    // Process payment filter and format response
    const results = rows.map(s => {
      const isPaid = Boolean(s.is_paid_current_month);
      return {
        ...s,
        display_roll: `#${s.roll_number}`,
        current_month_status: isPaid ? 'Paid' : 'Due'
      };
    }).filter(s => {
      if (paymentFilter === 'all') return true;
      if (paymentFilter === 'Paid') return s.current_month_status === 'Paid';
      if (paymentFilter === 'Due') return s.current_month_status === 'Due';
      return true;
    });

    res.json({
      success: true,
      data: results,
      total: results.length,
      currentMonth
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/students/lookup', (req, res) => {
  try {
    const query = (((req.query.query) || (req.query.q) || '')).trim();
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const currentMonth = (req.query.month) || getCurrentMonth();

    if (!query && !classId) {
      return res.json({ success: true, students: [], exactMatch: null });
    }

    let sql = `
      SELECT s.*, c.name as class_name, c.class_number, c.monthly_fee, ay.year as academic_year
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE 1=1
    `;
    const params = [];

    if (classId) {
      sql += ' AND s.class_id = ?';
      params.push(classId);
    }

    let parsedRoll = null;
    let cleanStuQuery = query.replace(/^#/, '').trim();
    if (cleanStuQuery) {
      const stuMatch = cleanStuQuery.match(/^stu[-_]?(?:20\d{2})?[-_]?0*(\d+)$/i) || cleanStuQuery.match(/^stu[-_]?0*(\d+)$/i);
      if (stuMatch) {
        parsedRoll = parseInt(stuMatch[1], 10);
      } else {
        const pureDigits = cleanStuQuery.replace(/[^0-9]/g, '');
        if (pureDigits.length > 0 && pureDigits.length <= 5) {
          parsedRoll = parseInt(pureDigits, 10);
        }
      }

      sql += ` AND (
        LOWER(s.name) LIKE ? OR 
        LOWER(s.father_name) LIKE ? OR 
        s.phone LIKE ? OR 
        CAST(s.roll_number AS TEXT) LIKE ? OR
        ('stu-' || ay.year || '-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || s.roll_number) LIKE ?
      `;
      const wild = `%${cleanStuQuery.toLowerCase()}%`;
      params.push(wild, wild, wild, wild, wild, wild, wild);

      if (parsedRoll !== null) {
        sql += ` OR s.roll_number = ?`;
        params.push(parsedRoll);
      }
      sql += ` )`;
    }

    if (cleanStuQuery) {
      sql += ' ORDER BY c.class_number ASC, s.roll_number ASC LIMIT 30';
    } else {
      sql += ' ORDER BY s.roll_number ASC LIMIT 200';
    }

    const students = db.prepare(sql).all(...params);

    const enriched = students.map(st => {
      const payment = db.prepare(`
        SELECT * FROM payments 
        WHERE student_id = ? AND month = ? AND academic_year_id = ?
        LIMIT 1
      `).get(st.id, currentMonth, st.academic_year_id);

      return {
        ...st,
        system_id: `STU-${st.academic_year}-${String(st.roll_number).padStart(4, '0')}`,
        current_month_status: payment ? 'Paid' : 'Due',
        payment: payment || null
      };
    });

    // Determine exact match if user typed an exact roll or student ID
    let exactMatch = null;
    if (cleanStuQuery) {
      const lowerQ = cleanStuQuery.toLowerCase();
      exactMatch = enriched.find(s =>
        s.system_id.toLowerCase() === lowerQ ||
        String(s.roll_number) === cleanStuQuery ||
        (parsedRoll !== null && s.roll_number === parsedRoll && (!classId || s.class_id === classId))
      ) || null;

      if (!exactMatch) {
        exactMatch = enriched.find(s => s.name.toLowerCase() === lowerQ) || null;
      }
      if (!exactMatch && enriched.length === 1 && cleanStuQuery.length >= 2) {
        exactMatch = enriched[0];
      }
    }

    res.json({
      success: true,
      students: enriched,
      exactMatch
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/students/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const student = db.prepare(`
      SELECT s.*, c.name as class_name, c.class_number, c.monthly_fee, ay.year as academic_year
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE s.id = ?
    `).get(id);

    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // Get all payments for this student
    const payments = db.prepare(`
      SELECT * FROM payments 
      WHERE student_id = ? AND academic_year_id = ?
      ORDER BY payment_date DESC, id DESC
    `).all(id, student.academic_year_id);

    const paymentsByMonth = new Map();
    payments.forEach(p => paymentsByMonth.set(p.month, p));

    // Calculate month-by-month status for 12 months
    const admDate = new Date(student.admission_date);
    const admMonthIndex = isNaN(admDate.getTime()) ? 0 : admDate.getMonth(); // 0 = Jan
    const currentMonthIndex = getCurrentMonthIndex();

    let totalPaid = 0;
    let totalDue = 0;
    let paidCount = 0;
    let dueCount = 0;

    const monthlyBreakdown = MONTHS.map((monthName, idx) => {
      const payment = paymentsByMonth.get(monthName);
      let status;

      if (idx < admMonthIndex) {
        status = 'NOT_APPLICABLE';
      } else if (payment) {
        status = 'PAID';
        totalPaid += payment.amount;
        paidCount++;
      } else if (idx <= currentMonthIndex) {
        status = 'DUE';
        totalDue += student.monthly_fee;
        dueCount++;
      } else {
        status = 'UPCOMING';
      }

      return {
        month: monthName,
        monthIndex: idx + 1,
        status,
        payment: payment || null,
        fee: student.monthly_fee
      };
    });

    res.json({
      success: true,
      data: {
        student: {
          ...student,
          display_roll: `#${student.roll_number}`
        },
        summary: {
          totalPaid,
          totalDue,
          paidCount,
          dueCount,
          monthlyFee: student.monthly_fee
        },
        monthlyBreakdown,
        payments
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/students', (req, res) => {
  try {
    const {
      name,
      father_name,
      mother_name,
      phone,
      address,
      class_id,
      admission_date,
      academic_year_id,
      photo_url
    } = req.body;

    if (!name || !phone || !class_id) {
      return res.status(400).json({ success: false, error: 'Student Name, Phone and Class are required' });
    }

    const ayId = resolveAcademicYear(academic_year_id).id;
    const classId = parseInt(class_id, 10);
    const admDate = admission_date || getDhakaDate();

    // Auto generate next roll inside transaction
    const nextRoll = getNextRollNumber(ayId, classId);

    const insert = db.prepare(`
      INSERT INTO students (
        academic_year_id, class_id, roll_number, name, father_name, mother_name,
        phone, address, admission_date, status, photo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)
    `);

    const result = insert.run(
      ayId,
      classId,
      nextRoll,
      name.trim(),
      father_name && father_name.trim() ? father_name.trim() : null,
      mother_name && mother_name.trim() ? mother_name.trim() : null,
      phone.trim(),
      address && address.trim() ? address.trim() : null,
      admDate,
      photo_url && photo_url.trim() ? photo_url.trim() : null
    );

    res.json({
      success: true,
      data: {
        id: Number(result.lastInsertRowid),
        roll_number: nextRoll,
        display_roll: `#${nextRoll}`,
        name
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.put('/students/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid student ID' });
    }

    const current = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    const { name, father_name, mother_name, phone, address, status, admission_date, photo_url, class_id } = req.body;

    // Process name: must not be empty if provided
    let updatedName = current.name;
    if (name !== undefined) {
      const trimmed = (name || '').trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: 'Student name cannot be empty' });
      }
      updatedName = trimmed;
    }

    // Process phone: must not be empty if provided
    let updatedPhone = current.phone;
    if (phone !== undefined) {
      const trimmed = (phone || '').trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: 'Phone number cannot be empty' });
      }
      updatedPhone = trimmed;
    }

    // Process father_name: if provided, update to trimmed string or null if empty
    let updatedFather = current.father_name;
    if (father_name !== undefined) {
      const trimmed = (father_name || '').trim();
      updatedFather = (trimmed && trimmed !== 'N/A' && trimmed !== 'null') ? trimmed : null;
    }

    // Process mother_name: if provided, update to trimmed string or null if empty
    let updatedMother = current.mother_name;
    if (mother_name !== undefined) {
      const trimmed = (mother_name || '').trim();
      updatedMother = (trimmed && trimmed !== 'N/A' && trimmed !== 'null') ? trimmed : null;
    }

    // Process address: if provided, update to trimmed string or null if empty
    let updatedAddress = current.address;
    if (address !== undefined) {
      const trimmed = (address || '').trim();
      updatedAddress = (trimmed && trimmed !== 'N/A' && trimmed !== 'null') ? trimmed : null;
    }

    // Process class_id
    let updatedClassId = current.class_id;
    if (class_id !== undefined && class_id) {
      const parsedCls = parseInt(class_id, 10);
      if (!isNaN(parsedCls)) {
        const clsExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(parsedCls);
        if (clsExists) {
          updatedClassId = parsedCls;
        }
      }
    }

    // Process status: Active or Inactive
    let updatedStatus = current.status;
    if (status !== undefined && status) {
      updatedStatus = status;
    }

    // Process admission_date
    let updatedAdmDate = current.admission_date;
    if (admission_date !== undefined && admission_date) {
      updatedAdmDate = admission_date;
    }

    // Process photo_url
    let updatedPhoto = current.photo_url;
    if (photo_url !== undefined) {
      const trimmed = (photo_url || '').trim();
      updatedPhoto = trimmed ? trimmed : null;
    }

    db.prepare(`
      UPDATE students SET 
        name = ?,
        father_name = ?,
        mother_name = ?,
        phone = ?,
        address = ?,
        status = ?,
        admission_date = ?,
        photo_url = ?,
        class_id = ?,
        updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(
      updatedName,
      updatedFather,
      updatedMother,
      updatedPhone,
      updatedAddress,
      updatedStatus,
      updatedAdmDate,
      updatedPhoto,
      updatedClassId,
      id
    );

    res.json({
      success: true,
      message: 'Student profile updated successfully',
      data: {
        id,
        name: updatedName,
        father_name: updatedFather,
        mother_name: updatedMother,
        phone: updatedPhone,
        address: updatedAddress,
        status: updatedStatus,
        admission_date: updatedAdmDate
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/students/:id/status', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!status || !['Active', 'Inactive'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be Active or Inactive' });
    }

    db.prepare('UPDATE students SET status = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(status, id);
    res.json({ success: true, message: `Student marked as ${status}` });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/students/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid student ID' });
    }

    const student = db.prepare('SELECT id, name, roll_number FROM students WHERE id = ?').get(id);
    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // Delete associated payments first to prevent foreign key restrict violations
    db.prepare('DELETE FROM payments WHERE student_id = ?').run(id);

    // Delete student record
    db.prepare('DELETE FROM students WHERE id = ?').run(id);

    res.json({
      success: true,
      message: `Student "${student.name}" (Roll #${student.roll_number}) and all payment history were deleted successfully`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// PAYMENTS & RECEIPT
// ----------------------------------------------------
apiRouter.get('/payments', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const month = req.query.month || null;
    const studentSearch = (req.query.search || '').trim().toLowerCase();
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    let query = `
      SELECT p.*, s.name as student_name, s.roll_number, s.phone as student_phone,
        c.name as class_name, c.class_number
      FROM payments p
      JOIN students s ON p.student_id = s.id
      JOIN classes c ON p.class_id = c.id
      WHERE p.academic_year_id = ?
    `;
    const params = [ayId];

    if (classId) {
      query += ' AND p.class_id = ?';
      params.push(classId);
    }
    if (month && month !== 'all') {
      query += ' AND p.month = ?';
      params.push(month);
    }
    if (startDate) {
      query += ' AND p.payment_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND p.payment_date <= ?';
      params.push(endDate);
    }
    if (studentSearch) {
      query += ' AND (LOWER(s.name) LIKE ? OR CAST(s.roll_number AS TEXT) LIKE ? OR p.receipt_no LIKE ?)';
      const wild = `%${studentSearch}%`;
      params.push(wild, wild, wild);
    }

    query += ' ORDER BY p.payment_date DESC, p.id DESC';

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/payments', (req, res) => {
  try {
    const { student_id, month, payment_method, note, payment_date, payment_time } = req.body;
    if (!student_id || !month) {
      return res.status(400).json({ success: false, error: 'Student and billing month are required' });
    }

    const studentId = parseInt(student_id, 10);
    const student = db.prepare(`
      SELECT s.*, c.monthly_fee, c.name as class_name, ay.year as academic_year
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE s.id = ?
    `).get(studentId);

    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // Check duplicate payment constraint: student + month + academic_year
    const existing = db.prepare(`
      SELECT * FROM payments 
      WHERE student_id = ? AND month = ? AND academic_year_id = ?
    `).get(studentId, month, student.academic_year_id);

    if (existing) {
      return res.status(400).json({
        success: false,
        error: `Fee for ${month} has already been paid on ${existing.payment_date} (Receipt ${existing.receipt_no}). Duplicate payment rejected.`
      });
    }

    // Determine current date and time in local coaching timezone
    const now = new Date();
    const dateStr = payment_date || getDhakaDate(now);
    const timeStr = payment_time || getDhakaTime(now);

    // Generate unique receipt number
    const maxRec = db.prepare("SELECT COUNT(*) as cnt FROM payments").get();
    const receiptNo = `REC-${student.academic_year}-${String(1000 + maxRec.cnt + 1).padStart(4, '0')}`;

    // Fixed Fee Protection Rule: student monthly tuition fee is predefined and fixed
    if (req.body.amount !== undefined && req.body.amount !== null && String(req.body.amount).trim() !== '') {
      const enteredAmount = parseFloat(req.body.amount);
      if (isNaN(enteredAmount) || Math.abs(enteredAmount - student.monthly_fee) > 0.01) {
        return res.status(400).json({
          success: false,
          error: `Student monthly tuition fee is fixed at ৳${student.monthly_fee}. Collecting partial or modified amounts (৳${enteredAmount}) is not allowed. Use "Others" income for miscellaneous collections.`
        });
      }
    }
    const finalAmount = student.monthly_fee;

    const insert = db.prepare(`
      INSERT INTO payments (
        student_id, academic_year_id, class_id, month, year, amount,
        payment_date, payment_time, payment_method, receipt_no, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      studentId,
      student.academic_year_id,
      student.class_id,
      month,
      student.academic_year,
      finalAmount,
      dateStr,
      timeStr,
      payment_method || 'Cash',
      receiptNo,
      note || 'Monthly tuition fee'
    );

    res.json({
      success: true,
      message: `Payment of ৳${finalAmount} recorded successfully`,
      data: {
        paymentId: Number(result.lastInsertRowid),
        id: Number(result.lastInsertRowid),
        receiptNo,
        receipt_no: receiptNo,
        studentName: student.name,
        student_name: student.name,
        roll: student.roll_number,
        roll_number: student.roll_number,
        className: student.class_name,
        class_name: student.class_name,
        month,
        year: student.academic_year,
        amount: finalAmount,
        date: dateStr,
        payment_date: dateStr,
        time: timeStr,
        payment_time: timeStr,
        payment_method: payment_method || 'Cash',
        note: note || 'Monthly tuition fee',
        remarks: note || 'Monthly tuition fee'
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// MONTHLY OVERVIEW (12-MONTH MATRIX & DUE LIST)
// ----------------------------------------------------
apiRouter.get('/overview/matrix', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    let classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const targetMonth = (req.query.month) || getCurrentMonth();

    // If no classId provided, default to Class 5 (as in screenshot) or first class
    if (!classId) {
      const cls5 = db.prepare("SELECT id FROM classes WHERE academic_year_id = ? AND class_number = 5").get(ayId);
      if (cls5) {
        classId = cls5.id;
      } else {
        const firstCls = db.prepare("SELECT id FROM classes WHERE academic_year_id = ? ORDER BY class_number ASC LIMIT 1").get(ayId);
        classId = firstCls ? firstCls.id : 1;
      }
    }

    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }

    // Get all students in this class
    const students = db.prepare(`
      SELECT s.* FROM students s
      WHERE s.class_id = ? AND s.academic_year_id = ?
      ORDER BY s.roll_number ASC
    `).all(classId, ayId);

    // Get all payments for this class and year
    const payments = db.prepare(`
      SELECT * FROM payments
      WHERE class_id = ? AND academic_year_id = ?
    `).all(classId, ayId);

    const payMap = new Map(); // key: `${student_id}_${month}`
    payments.forEach(p => {
      payMap.set(`${p.student_id}_${p.month}`, p);
    });

    const targetMonthIdx = MONTHS.indexOf(targetMonth);
    const activeTargetIdx = targetMonthIdx >= 0 ? targetMonthIdx : 8; // default Sep = 8

    let totalEnrolled = students.length;
    let targetClearedCount = 0;
    let targetDueCount = 0;
    let grossCollectedTargetMonth = 0;
    let expectedTargetAmount = totalEnrolled * cls.monthly_fee;

    const rows = students.map(st => {
      const admDate = new Date(st.admission_date);
      const admMonthIdx = isNaN(admDate.getTime()) ? 0 : admDate.getMonth();

      const monthsStatus = {};

      MONTHS.forEach((mName, mIdx) => {
        const payment = payMap.get(`${st.id}_${mName}`);
        if (mIdx < admMonthIdx) {
          monthsStatus[mName] = { status: 'NOT_APPLICABLE', label: '—' };
        } else if (payment) {
          const amtLabel = payment.amount >= 1000
            ? `✓ ৳${(payment.amount / 1000).toFixed(payment.amount % 1000 === 0 ? 0 : 1)}k`
            : `✓ ৳${payment.amount}`;
          monthsStatus[mName] = {
            status: 'PAID',
            label: amtLabel,
            receipt: payment.receipt_no,
            amount: payment.amount,
            date: payment.payment_date,
            note: payment.note || 'Monthly tuition fee',
            remarks: payment.note || 'Monthly tuition fee',
            payment_method: payment.payment_method || 'Cash'
          };
        } else if (mIdx <= activeTargetIdx) {
          monthsStatus[mName] = { status: 'DUE', label: 'DUE', amount: cls.monthly_fee };
        } else {
          monthsStatus[mName] = { status: 'UPCOMING', label: '—' };
        }
      });

      const targetCell = monthsStatus[targetMonth];
      if (targetCell?.status === 'PAID') {
        targetClearedCount++;
        grossCollectedTargetMonth += (targetCell.amount || cls.monthly_fee);
      } else if (targetCell?.status === 'DUE') {
        targetDueCount++;
      }

      return {
        id: st.id,
        roll: st.roll_number,
        display_roll: `#${st.roll_number}`,
        name: st.name,
        phone: st.phone,
        father: st.father_name,
        status: st.status,
        monthly_fee: cls.monthly_fee,
        months: monthsStatus
      };
    });

    const clearedPercent = totalEnrolled > 0 ? ((targetClearedCount / totalEnrolled) * 100).toFixed(1) : '0';
    const duePercent = totalEnrolled > 0 ? ((targetDueCount / totalEnrolled) * 100).toFixed(1) : '0';
    const unsettledAmount = expectedTargetAmount - grossCollectedTargetMonth;

    const targetYearRow = db.prepare('SELECT year FROM academic_years WHERE id = ?').get(ayId);
    const ayYear = targetYearRow ? targetYearRow.year : 2026;

    res.json({
      success: true,
      academicYear: ayYear,
      academicYearId: ayId,
      classInfo: cls,
      targetMonth,
      stats: {
        totalEnrolled,
        clearedCount: targetClearedCount,
        clearedPercent: parseFloat(clearedPercent),
        dueCount: targetDueCount,
        duePercent: parseFloat(duePercent),
        grossCollected: grossCollectedTargetMonth,
        expectedTarget: expectedTargetAmount,
        unsettledAmount
      },
      rows
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/overview/due-list', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const targetMonth = (req.query.month) || getCurrentMonth();

    let query = `
      SELECT s.id, s.roll_number, s.name, s.phone, s.admission_date, c.id as class_id, c.name as class_name, c.monthly_fee
      FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE s.academic_year_id = ? 
        AND NOT EXISTS (
          SELECT 1 FROM payments p 
          WHERE p.student_id = s.id 
            AND p.month = ? 
            AND p.academic_year_id = ?
        )
    `;
    const params = [ayId, targetMonth, ayId];

    if (classId) {
      query += ' AND s.class_id = ?';
      params.push(classId);
    }

    query += ' ORDER BY c.class_number ASC, s.roll_number ASC';

    const rows = db.prepare(query).all(...params);

    // Calculate total due months for each student
    const targetMonthIdx = MONTHS.indexOf(targetMonth);
    const results = rows.map(st => {
      const admDate = new Date(st.admission_date);
      const admMonthIdx = isNaN(admDate.getTime()) ? 0 : admDate.getMonth();

      // Check how many months between admission and target are unpaid
      let unpaidMonths = [];
      for (let i = admMonthIdx; i <= targetMonthIdx; i++) {
        const m = MONTHS[i];
        const paid = db.prepare('SELECT 1 FROM payments WHERE student_id = ? AND month = ? AND academic_year_id = ?').get(st.id, m, ayId);
        if (!paid) {
          unpaidMonths.push(m);
        }
      }

      return {
        ...st,
        display_roll: `#${st.roll_number}`,
        targetMonth,
        unpaidMonthsCount: unpaidMonths.length,
        unpaidMonths,
        totalDueAmount: unpaidMonths.length * st.monthly_fee
      };
    });

    res.json({
      success: true,
      targetMonth,
      totalDueStudents: results.length,
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// EXPENSES & CATEGORIES
// ----------------------------------------------------
const getExpenseCategoriesHandler = (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ec.*, 
        COUNT(e.id) as expense_count,
        COALESCE(SUM(e.amount), 0) as total_amount
      FROM expense_categories ec
      LEFT JOIN expenses e ON ec.id = e.category_id
      GROUP BY ec.id
      ORDER BY CASE WHEN LOWER(TRIM(ec.name)) IN ('other', 'others') THEN 1 ELSE 0 END ASC, ec.name ASC
    `).all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

apiRouter.get('/expense-categories', getExpenseCategoriesHandler);
apiRouter.get('/expenses/categories', getExpenseCategoriesHandler);

const postExpenseCategoriesHandler = (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Category name is required' });
    }

    const insert = db.prepare('INSERT INTO expense_categories (name, is_default) VALUES (?, 0)');
    const resRow = insert.run(name.trim());
    res.json({ success: true, data: { id: Number(resRow.lastInsertRowid), name: name.trim() } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

apiRouter.post('/expense-categories', postExpenseCategoriesHandler);
apiRouter.post('/expenses/categories', postExpenseCategoriesHandler);

apiRouter.get('/expenses', (req, res) => {
  try {
    const categoryId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    const search = (req.query.search || '').trim().toLowerCase();

    let query = `
      SELECT e.*, ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE 1=1
    `;
    const params = [];

    if (categoryId) {
      query += ' AND e.category_id = ?';
      params.push(categoryId);
    }
    if (startDate) {
      query += ' AND e.expense_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND e.expense_date <= ?';
      params.push(endDate);
    }
    if (search) {
      query += ' AND (LOWER(e.description) LIKE ? OR LOWER(ec.name) LIKE ? OR e.voucher_no LIKE ?)';
      const wild = `%${search}%`;
      params.push(wild, wild, wild);
    }

    query += ' ORDER BY e.expense_date DESC, e.id DESC';

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/expenses', (req, res) => {
  try {
    const { category_id, amount, description, expense_date, expense_time } = req.body;
    const amt = parseFloat(amount);
    const catId = parseInt(category_id, 10);

    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid positive amount required' });
    }
    if (!catId || !description) {
      return res.status(400).json({ success: false, error: 'Category and description are required' });
    }

    const now = new Date();
    const dateStr = expense_date || getDhakaDate(now);
    const timeStr = expense_time || getDhakaTime(now);

    // Auto voucher number
    const maxVoucher = db.prepare('SELECT COUNT(*) as count FROM expenses').get();
    const voucherNo = `V-${String(100 + maxVoucher.count + 1)}`;

    const insert = db.prepare(`
      INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(catId, amt, description.trim(), dateStr, timeStr, voucherNo);
    const cat = db.prepare('SELECT name FROM expense_categories WHERE id = ?').get(catId);
    res.json({
      success: true,
      data: {
        id: Number(result.lastInsertRowid),
        voucher_no: voucherNo,
        voucherNo,
        category_id: catId,
        category_name: cat ? cat.name : 'General Expense',
        amount: amt,
        description: description.trim(),
        expense_date: dateStr,
        expense_time: timeStr
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.get('/expenses/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const expense = db.prepare(`
      SELECT e.*, ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE e.id = ?
    `).get(id);
    if (!expense) {
      return res.status(404).json({ success: false, error: 'Expense not found' });
    }
    res.json({ success: true, data: expense });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/expense-categories/:id/details', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const category = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id);
    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    const items = db.prepare(`
      SELECT * FROM expenses WHERE category_id = ? ORDER BY expense_date DESC, id DESC
    `).all(id);

    res.json({ success: true, category, data: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/expenses/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    res.json({ success: true, message: 'Expense voucher deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.put('/payments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, note, payment_method, payment_date } = req.body;
    const current = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }
    const rawAmount = amount !== undefined ? parseFloat(amount) : current.amount;
    const finalAmount = (!isNaN(rawAmount) && rawAmount >= 0) ? rawAmount : current.amount;
    const finalNote = note !== undefined ? note : current.note;
    const finalMethod = payment_method || current.payment_method;
    const finalDate = payment_date || current.payment_date;

    db.prepare(`
      UPDATE payments SET
        amount = ?,
        note = ?,
        payment_method = ?,
        payment_date = ?
      WHERE id = ?
    `).run(finalAmount, finalNote, finalMethod, finalDate, id);

    const updated = db.prepare(`
      SELECT p.*, s.name as student_name, s.roll_number, c.name as class_name
      FROM payments p
      JOIN students s ON p.student_id = s.id
      JOIN classes c ON p.class_id = c.id
      WHERE p.id = ?
    `).get(id);

    res.json({
      success: true,
      message: `Payment updated to ৳${finalAmount}`,
      data: updated
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/payments/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    res.json({ success: true, message: 'Payment record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// FINANCIAL DASHBOARD (DYNAMIC SQLite CALCULATIONS)
// ----------------------------------------------------
apiRouter.get('/dashboard', (req, res) => {
  try {
    const ayRow = resolveAcademicYear(req.query.academic_year_id);
    const ayId = ayRow.id;
    const currentAcademicYear = ayRow.year;

    // Dynamic dates & timezone reconciliation (client date or Dhaka UTC+6)
    const clientDate = req.query.client_date || req.query.date || req.headers['x-client-date'];
    const { today, weekStart, weekEnd, monthStart, monthEnd } = getDateRangeContext(clientDate);
    const yearStart = `${currentAcademicYear}-01-01`;

    // Income calculations
    const todayIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ?
        AND (
          payment_date = ?
          OR date(created_at) = ?
          OR date(created_at, '+6 hours') = ?
        )
    `).get(ayId, today, today, today);

    const weekIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ?
        AND (
          (payment_date >= ? AND payment_date <= ?)
          OR (date(created_at) >= ? AND date(created_at) <= ?)
          OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
        )
    `).get(ayId, weekStart, weekEnd, weekStart, weekEnd, weekStart, weekEnd);

    const monthIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ?
        AND (
          (payment_date >= ? AND payment_date <= ?)
          OR (date(created_at) >= ? AND date(created_at) <= ?)
          OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
        )
    `).get(ayId, monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

    const overallIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments WHERE academic_year_id = ?
    `).get(ayId);

    // Include Others Miscellaneous Income in totals
    const todayOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections WHERE collection_date = ?
    `).get(today);
    todayIncomeRow.total += (todayOtherRow?.total || 0);
    todayIncomeRow.count += (todayOtherRow?.count || 0);

    const weekOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections WHERE collection_date >= ? AND collection_date <= ?
    `).get(weekStart, weekEnd);
    weekIncomeRow.total += (weekOtherRow?.total || 0);
    weekIncomeRow.count += (weekOtherRow?.count || 0);

    const monthOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections WHERE collection_date >= ? AND collection_date <= ?
    `).get(monthStart, monthEnd);
    monthIncomeRow.total += (monthOtherRow?.total || 0);
    monthIncomeRow.count += (monthOtherRow?.count || 0);

    const overallOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections
    `).get();
    overallIncomeRow.total += (overallOtherRow?.total || 0);
    overallIncomeRow.count += (overallOtherRow?.count || 0);

    // Expense calculations
    const todayExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        expense_date = ?
        OR date(created_at) = ?
        OR date(created_at, '+6 hours') = ?
      )
    `).get(today, today, today);

    const weekExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        (expense_date >= ? AND expense_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(weekStart, weekEnd, weekStart, weekEnd, weekStart, weekEnd);

    const monthExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        (expense_date >= ? AND expense_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

    const overallExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
    `).get();

    // Student counts
    const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students WHERE academic_year_id = ?').get(ayId);
    const activeClasses = db.prepare('SELECT COUNT(*) as count FROM classes WHERE academic_year_id = ?').get(ayId);

    // Target month for dashboard analysis (defaults to current month)
    const activeMonth = (req.query.month) || getCurrentMonth();

    // Due students count in current active month
    const dueCountRow = db.prepare(`
      SELECT COUNT(*) as count FROM students s
      WHERE s.academic_year_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM payments p 
          WHERE p.student_id = s.id AND p.month = ? AND p.academic_year_id = s.academic_year_id
        )
    `).get(ayId, activeMonth);

    // Net balance calculations: Net = Income - Expense
    const todayNet = todayIncomeRow.total - todayExpenseRow.total;
    const weekNet = weekIncomeRow.total - weekExpenseRow.total;
    const monthNet = monthIncomeRow.total - monthExpenseRow.total;
    const overallNet = overallIncomeRow.total - overallExpenseRow.total;

    // Class Overview & Collection Rates
    const classes = db.prepare(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) as student_count,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.class_id = c.id AND p.month = ? AND p.academic_year_id = c.academic_year_id) as collected_amount
      FROM classes c
      WHERE c.academic_year_id = ?
      ORDER BY c.class_number ASC
    `).all(activeMonth, ayId);

    let totalProjected = 0;
    let totalCollectedSeptember = 0;

    const classOverview = classes.map(c => {
      const students = c.student_count || 0;
      const expected = students * c.monthly_fee;
      const collected = c.collected_amount || 0;
      const due = Math.max(0, expected - collected);
      const recoveryRate = expected > 0 ? ((collected / expected) * 100).toFixed(1) : '100';

      totalProjected += expected;
      totalCollectedSeptember += collected;

      return {
        id: c.id,
        name: c.name,
        class_number: c.class_number,
        students,
        monthly_fee: c.monthly_fee,
        expected,
        collected,
        due,
        recoveryRate: parseFloat(recoveryRate)
      };
    });

    const aggregateEfficiency = totalProjected > 0 ? ((totalCollectedSeptember / totalProjected) * 100).toFixed(1) : '0';

    // All due students for current active month
    const priorityDue = db.prepare(`
      SELECT s.id, s.roll_number, s.name, c.name as class_name, c.class_number, c.monthly_fee
      FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE s.academic_year_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM payments p WHERE p.student_id = s.id AND p.month = ? AND p.academic_year_id = s.academic_year_id
        )
      ORDER BY c.class_number ASC, s.roll_number ASC
    `).all(ayId, activeMonth);

    const dueUnpaidTotal = priorityDue.reduce((sum, st) => sum + (st.monthly_fee || 0), 0);

    // Recent Transactions audit trail (latest payments & expenses combined)
    const recentPayments = db.prepare(`
      SELECT p.id, p.amount, p.payment_date as date, p.payment_time as time, p.receipt_no as ref_no,
        p.created_at, s.name as student_name, c.name as class_name, p.month
      FROM payments p
      LEFT JOIN students s ON p.student_id = s.id
      LEFT JOIN classes c ON p.class_id = c.id
      WHERE p.academic_year_id = ?
      ORDER BY p.id DESC
      LIMIT 25
    `).all(ayId);

    const recentExpenses = db.prepare(`
      SELECT e.id, e.amount, e.expense_date as date, e.expense_time as time, e.voucher_no as ref_no,
        e.created_at, e.description, COALESCE(ec.name, 'Expense') as category_name
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      ORDER BY e.id DESC
      LIMIT 25
    `).all();

    const toSortKey = (row) => {
      const datePart = String(row.date || row.created_at || '').slice(0, 10);
      const created = String(row.created_at || datePart || '');
      return `${datePart} ${created} ${String(row.id).padStart(8, '0')}`;
    };

    const recentTransactions = [
      ...recentPayments.map(p => ({
        id: `p-${p.id}`,
        title: `${p.student_name || 'Student'} - ${p.class_name || 'Class'} ${p.month || ''} Fee`.trim(),
        subtitle: `Receipt #${p.ref_no || p.id}`,
        amount: p.amount,
        type: 'income',
        date: p.date,
        time: p.time || '',
        sortKey: toSortKey(p)
      })),
      ...recentExpenses.map(e => ({
        id: `e-${e.id}`,
        title: `${e.category_name} - ${e.description}`,
        subtitle: `Voucher #${e.ref_no || e.id}`,
        amount: e.amount,
        type: 'expense',
        date: e.date,
        time: e.time || '',
        sortKey: toSortKey(e)
      }))
    ].sort((a, b) => b.sortKey.localeCompare(a.sortKey)).slice(0, 30);

    // Monthly chart from real income (payments) and expenses
    const chartMonthMeta = [
      { key: 'January', short: 'Jan', num: '01' },
      { key: 'February', short: 'Feb', num: '02' },
      { key: 'March', short: 'Mar', num: '03' },
      { key: 'April', short: 'Apr', num: '04' },
      { key: 'May', short: 'May', num: '05' },
      { key: 'June', short: 'Jun', num: '06' },
      { key: 'July', short: 'Jul', num: '07' },
      { key: 'August', short: 'Aug', num: '08' },
      { key: 'September', short: 'Sep', num: '09' },
      { key: 'October', short: 'Oct', num: '10' },
      { key: 'November', short: 'Nov', num: '11' },
      { key: 'December', short: 'Dec', num: '12' }
    ];

    const incomeByMonthStmt = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE academic_year_id = ? AND month = ?
    `);
    const expenseByMonthStmt = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE strftime('%m', expense_date) = ?
    `);

    const chartData = chartMonthMeta.map(m => {
      const income = incomeByMonthStmt.get(ayId, m.key).total;
      const expense = expenseByMonthStmt.get(m.num).total;
      const net = income - expense;
      const margin = income > 0 ? parseFloat(((net / income) * 100).toFixed(1)) : 0;
      return { month: m.short, income, expense, net, margin };
    });

    res.json({
      success: true,
      academicYear: currentAcademicYear,
      stats: {
        totalStudents: totalStudents.count,
        activeStudents: totalStudents.count,
        activeClasses: activeClasses.count,
        dueStudentsCount: dueCountRow.count,
        today: {
          income: todayIncomeRow.total,
          paymentsCount: todayIncomeRow.count,
          expense: todayExpenseRow.total,
          vouchersCount: todayExpenseRow.count,
          net: todayNet,
          margin: todayIncomeRow.total > 0 ? ((todayNet / todayIncomeRow.total) * 100).toFixed(1) : '0'
        },
        weekly: {
          income: weekIncomeRow.total,
          paymentsCount: weekIncomeRow.count || 0,
          expense: weekExpenseRow.total,
          vouchersCount: weekExpenseRow.count || 0,
          net: weekNet
        },
        monthly: {
          income: monthIncomeRow.total,
          paymentsCount: monthIncomeRow.count || 0,
          expense: monthExpenseRow.total,
          vouchersCount: monthExpenseRow.count || 0,
          net: monthNet
        },
        overall: {
          income: overallIncomeRow.total,
          paymentsCount: overallIncomeRow.count || 0,
          expense: overallExpenseRow.total,
          vouchersCount: overallExpenseRow.count || 0,
          net: overallNet
        }
      },
      classOverview: {
        classes: classOverview,
        totalProjected,
        totalCollectedSeptember,
        aggregateEfficiency: parseFloat(aggregateEfficiency)
      },
      priorityDue,
      dueUnpaidTotal,
      recentTransactions,
      chartData
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// REPORTS
// ----------------------------------------------------
apiRouter.get('/reports/summary', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;

    const classReports = db.prepare(`
      SELECT c.id, c.name, c.class_number, c.monthly_fee,
        COUNT(s.id) as total_students,
        (COUNT(s.id) * c.monthly_fee * 9) as expected_till_sep,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.class_id = c.id AND p.academic_year_id = ?), 0) as total_collected
      FROM classes c
      LEFT JOIN students s ON s.class_id = c.id
      WHERE c.academic_year_id = ?
      GROUP BY c.id
      ORDER BY c.class_number ASC
    `).all(ayId, ayId);

    const expensesByCategory = db.prepare(`
      SELECT ec.name, COALESCE(SUM(e.amount), 0) as total
      FROM expense_categories ec
      LEFT JOIN expenses e ON ec.id = e.category_id
      GROUP BY ec.id
      ORDER BY total DESC
    `).all();

    res.json({
      success: true,
      classReports: classReports.map(c => ({
        ...c,
        due: Math.max(0, c.expected_till_sep - c.total_collected),
        efficiency: c.expected_till_sep > 0 ? ((c.total_collected / c.expected_till_sep) * 100).toFixed(1) : '100'
      })),
      expensesByCategory
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/reports/financial', (req, res) => {
  try {
    const period = (req.query.period) || 'month';
    const ayRow = resolveAcademicYear(req.query.academic_year_id);
    const ayId = ayRow.id;
    const currentYear = ayRow.year;

    const clientDate = req.query.client_date || req.query.date || req.headers['x-client-date'];
    const { today, weekStart, weekEnd, monthStart, monthEnd } = getDateRangeContext(clientDate);
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    let startDate = monthStart;
    let endDate = monthEnd;

    if (period === 'today') {
      startDate = today;
      endDate = today;
    } else if (period === 'week') {
      startDate = weekStart;
      endDate = weekEnd;
    } else if (period === 'month') {
      startDate = monthStart;
      endDate = monthEnd;
    } else if (period === 'year') {
      startDate = yearStart;
      endDate = yearEnd;
    }

    const incomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ? AND (
        (payment_date >= ? AND payment_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(ayId, startDate, endDate, startDate, endDate, startDate, endDate);

    const otherIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections
      WHERE collection_date >= ? AND collection_date <= ?
    `).get(startDate, endDate);
    if (otherIncomeRow) {
      incomeRow.total += (otherIncomeRow.total || 0);
      incomeRow.count += (otherIncomeRow.count || 0);
    }

    const expenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        (expense_date >= ? AND expense_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(startDate, endDate, startDate, endDate, startDate, endDate);

    const expenseCategories = db.prepare(`
      SELECT ec.name as category, COALESCE(SUM(e.amount), 0) as total
      FROM expense_categories ec
      JOIN expenses e ON ec.id = e.category_id
      WHERE e.expense_date >= ? AND e.expense_date <= ?
      GROUP BY ec.id
      ORDER BY total DESC
    `).all(startDate, endDate);

    const classRevenue = db.prepare(`
      SELECT c.name as className, COALESCE(SUM(p.amount), 0) as total
      FROM classes c
      JOIN payments p ON c.id = p.class_id
      WHERE p.academic_year_id = ? AND p.payment_date >= ? AND p.payment_date <= ?
      GROUP BY c.id
      ORDER BY total DESC
    `).all(ayId, startDate, endDate);

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const monthlyTrajectory = months.map(m => {
      const inc = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE academic_year_id = ? AND month = ?
      `).get(ayId, m);

      // Estimated expense distribution for trajectory
      const exp = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE strftime('%m', expense_date) = ? AND strftime('%Y', expense_date) = ?
      `).get(String(months.indexOf(m) + 1).padStart(2, '0'), String(currentYear));

      return {
        month: m,
        income: inc.total,
        expense: exp.total > 0 ? exp.total : 0
      };
    });

    res.json({
      success: true,
      data: {
        academicYear: currentYear,
        period,
        startDate,
        endDate,
        totalIncome: incomeRow.total,
        incomeCount: incomeRow.count,
        totalExpense: expenseRow.total,
        expenseCount: expenseRow.count,
        netBalance: incomeRow.total - expenseRow.total,
        expenseCategories,
        classRevenue,
        monthlyTrajectory
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// VOUCHER PRINTING APIS (DAILY & MONTHLY DYNAMIC VOUCHERS)
// ----------------------------------------------------

apiRouter.get('/vouchers/daily', (req, res) => {
  try {
    const rawDate = req.query.date || getDhakaDate();
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : getDhakaDate();

    // Format display date: e.g. "Monday, 28 September 2026"
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const formattedDate = dateObj.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const dayOfWeek = dateObj.toLocaleDateString('en-GB', { weekday: 'long' });

    // 1. Fetch Expenses on date
    const expenseRows = db.prepare(`
      SELECT e.id, e.category_id, e.amount, e.description, e.expense_date, e.expense_time, e.voucher_no,
             ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE e.expense_date = ?
      ORDER BY ec.name ASC, e.id ASC
    `).all(dateStr);

    // Group expenses by category
    const expenseCategoryMap = new Map();
    let totalExpense = 0;

    for (const exp of expenseRows) {
      totalExpense += exp.amount || 0;
      if (!expenseCategoryMap.has(exp.category_id)) {
        expenseCategoryMap.set(exp.category_id, {
          category_id: exp.category_id,
          category_name: exp.category_name,
          count: 0,
          total_amount: 0,
          items: []
        });
      }
      const cat = expenseCategoryMap.get(exp.category_id);
      cat.count += 1;
      cat.total_amount += exp.amount || 0;
      cat.items.push({
        id: exp.id,
        voucher_no: exp.voucher_no || `V-${exp.id}`,
        description: exp.description,
        time: exp.expense_time,
        amount: exp.amount
      });
    }

    const expenseCategories = Array.from(expenseCategoryMap.values());

    // 2. Fetch Student Fee Payments on date
    const paymentRows = db.prepare(`
      SELECT p.id, p.class_id, p.amount, p.payment_date, p.payment_time, p.payment_method, p.receipt_no, p.note,
             c.name as class_name, s.name as student_name, s.roll_number
      FROM payments p
      JOIN classes c ON p.class_id = c.id
      JOIN students s ON p.student_id = s.id
      WHERE p.payment_date = ?
      ORDER BY c.class_number ASC, p.id ASC
    `).all(dateStr);

    // Group payments by class/fee category
    const paymentCategoryMap = new Map();
    let totalPayment = 0;

    for (const p of paymentRows) {
      totalPayment += p.amount || 0;
      const catKey = p.class_id;
      if (!paymentCategoryMap.has(catKey)) {
        paymentCategoryMap.set(catKey, {
          class_id: p.class_id,
          category_name: p.class_name,
          count: 0,
          total_amount: 0,
          items: []
        });
      }
      const cat = paymentCategoryMap.get(catKey);
      cat.count += 1;
      cat.total_amount += p.amount || 0;
      cat.items.push({
        id: p.id,
        receipt_no: p.receipt_no,
        student_name: p.student_name,
        roll_number: p.roll_number,
        method: p.payment_method,
        time: p.payment_time,
        note: p.note,
        amount: p.amount
      });
    }

    // 3. Fetch Others Miscellaneous Income collections on date
    const otherRows = db.prepare(`
      SELECT id, description, amount, collection_date, collection_time, receipt_no, note
      FROM other_collections
      WHERE collection_date = ?
      ORDER BY id ASC
    `).all(dateStr);

    let otherIncomeTotal = 0;
    if (otherRows.length > 0) {
      const otherItems = [];
      for (const o of otherRows) {
        otherIncomeTotal += o.amount || 0;
        otherItems.push({
          id: o.id,
          receipt_no: o.receipt_no,
          student_name: o.description,
          roll_number: 'N/A',
          method: 'Cash',
          time: o.collection_time,
          note: o.note || o.description,
          amount: o.amount
        });
      }
      totalPayment += otherIncomeTotal;
      paymentCategoryMap.set('others', {
        class_id: 'others',
        category_name: 'Others Income',
        count: otherRows.length,
        total_amount: otherIncomeTotal,
        items: otherItems
      });
    }

    const paymentCategories = Array.from(paymentCategoryMap.values());

    res.json({
      success: true,
      data: {
        date: dateStr,
        formattedDate,
        dayOfWeek,
        expenses: {
          categories: expenseCategories,
          total: totalExpense,
          count: expenseRows.length
        },
        payments: {
          categories: paymentCategories,
          total: totalPayment,
          count: paymentRows.length + otherRows.length
        },
        netBalance: totalPayment - totalExpense
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/vouchers/monthly', (req, res) => {
  try {
    const today = getDhakaDate();
    const currentYear = parseInt(today.split('-')[0], 10);
    const currentMonth = parseInt(today.split('-')[1], 10);

    let year = parseInt(req.query.year, 10);
    if (isNaN(year) || year < 2000 || year > 2100) {
      const activeAy = getActiveAcademicYear();
      year = activeAy ? activeAy.year : currentYear;
    }

    let month = parseInt(req.query.month, 10);
    if (isNaN(month) || month < 1 || month > 12) {
      month = currentMonth;
    }

    const monthPadded = String(month).padStart(2, '0');
    const monthPrefix = `${year}-${monthPadded}`;

    // Get exact number of days for this specific month and year
    // Automatically returns 28/29 for February, 30 for Apr/Jun/Sep/Nov, 31 for others
    const totalDays = new Date(year, month, 0).getDate();

    const monthObj = new Date(year, month - 1, 1);
    const monthName = monthObj.toLocaleDateString('en-US', { month: 'long' });
    const formattedMonthYear = `${monthName} ${year}`;

    // 1. Fetch all expenses for that month
    const expenseRows = db.prepare(`
      SELECT e.id, e.amount, e.expense_date, e.voucher_no, ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE e.expense_date LIKE ?
      ORDER BY e.expense_date ASC, e.id ASC
    `).all(`${monthPrefix}-%`);

    const dailyExpensesMap = new Map();
    let totalExpense = 0;
    for (const exp of expenseRows) {
      totalExpense += exp.amount || 0;
      const d = exp.expense_date;
      if (!dailyExpensesMap.has(d)) {
        dailyExpensesMap.set(d, { total: 0, count: 0, items: [] });
      }
      const dayData = dailyExpensesMap.get(d);
      dayData.total += exp.amount || 0;
      dayData.count += 1;
      dayData.items.push(exp);
    }

    // 2. Fetch all payments for that month
    const paymentRows = db.prepare(`
      SELECT p.id, p.amount, p.payment_date, p.receipt_no, c.name as class_name, s.name as student_name
      FROM payments p
      JOIN classes c ON p.class_id = c.id
      JOIN students s ON p.student_id = s.id
      WHERE p.payment_date LIKE ?
      ORDER BY p.payment_date ASC, p.id ASC
    `).all(`${monthPrefix}-%`);

    const dailyPaymentsMap = new Map();
    let totalPayment = 0;
    for (const p of paymentRows) {
      totalPayment += p.amount || 0;
      const d = p.payment_date;
      if (!dailyPaymentsMap.has(d)) {
        dailyPaymentsMap.set(d, { total: 0, count: 0, items: [] });
      }
      const dayData = dailyPaymentsMap.get(d);
      dayData.total += p.amount || 0;
      dayData.count += 1;
      dayData.items.push(p);
    }

    // Include others collections for that month
    const otherMonthRows = db.prepare(`
      SELECT id, amount, collection_date, receipt_no, description
      FROM other_collections
      WHERE collection_date LIKE ?
      ORDER BY collection_date ASC, id ASC
    `).all(`${monthPrefix}-%`);

    for (const o of otherMonthRows) {
      totalPayment += o.amount || 0;
      const d = o.collection_date;
      if (!dailyPaymentsMap.has(d)) {
        dailyPaymentsMap.set(d, { total: 0, count: 0, items: [] });
      }
      const dayData = dailyPaymentsMap.get(d);
      dayData.total += o.amount || 0;
      dayData.count += 1;
      dayData.items.push({
        id: o.id,
        amount: o.amount,
        payment_date: o.collection_date,
        receipt_no: o.receipt_no,
        class_name: 'Others Income',
        student_name: o.description
      });
    }

    // 3. Build calendar matrix for every day (1..totalDays)
    const days = [];
    let daysWithExpenses = 0;
    let daysWithPayments = 0;

    for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
      const dayStr = String(dayNum).padStart(2, '0');
      const dateKey = `${year}-${monthPadded}-${dayStr}`;
      const dayDate = new Date(year, month - 1, dayNum);
      const dayOfWeekShort = dayDate.toLocaleDateString('en-US', { weekday: 'short' });
      const dayOfWeekLong = dayDate.toLocaleDateString('en-US', { weekday: 'long' });

      const expData = dailyExpensesMap.get(dateKey) || { total: 0, count: 0, items: [] };
      const payData = dailyPaymentsMap.get(dateKey) || { total: 0, count: 0, items: [] };

      if (expData.total > 0) daysWithExpenses++;
      if (payData.total > 0) daysWithPayments++;

      days.push({
        day: dayNum,
        date: dateKey,
        formattedDay: `${dayStr} ${monthName.substring(0, 3)}`,
        dayOfWeek: dayOfWeekShort,
        dayOfWeekLong,
        isWeekend: (dayDate.getDay() === 5 || dayDate.getDay() === 6), // Friday / Saturday in Bangladesh
        expenseAmount: expData.total,
        expenseCount: expData.count,
        paymentAmount: payData.total,
        paymentCount: payData.count,
        netAmount: payData.total - expData.total
      });
    }

    // 4. Collect available years dynamically
    const ayYears = db.prepare('SELECT year FROM academic_years ORDER BY year DESC').all().map(r => r.year);
    const expYears = db.prepare("SELECT DISTINCT substr(expense_date, 1, 4) as y FROM expenses WHERE expense_date IS NOT NULL").all().map(r => parseInt(r.y, 10));
    const payYears = db.prepare("SELECT DISTINCT substr(payment_date, 1, 4) as y FROM payments WHERE payment_date IS NOT NULL").all().map(r => parseInt(r.y, 10));

    const yearSet = new Set([currentYear, ...ayYears, ...expYears, ...payYears]);
    const availableYears = Array.from(yearSet).filter(y => !isNaN(y) && y > 2000).sort((a, b) => b - a);

    res.json({
      success: true,
      data: {
        year,
        month,
        monthName,
        formattedMonthYear,
        totalDays,
        totalExpense,
        totalPayment,
        netBalance: totalPayment - totalExpense,
        daysWithExpenses,
        daysWithPayments,
        days,
        availableYears
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(sqlite|db|sqlite3)$/i) || file.mimetype.includes('sqlite') || file.mimetype.includes('octet-stream') || file.mimetype.includes('sql')) {
      cb(null, true);
    } else {
      cb(new Error('Only SQLite database files (.sqlite, .db) are allowed'));
    }
  }
});

apiRouter.post('/database/restore', requireSuperAdmin, upload.single('database_file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No database file uploaded' });
    }

    const uploadedFilePath = req.file.path;
    const currentDbPath = getDbPath();

    // 1. Validate that the uploaded file is a valid SQLite database
    try {
      const headerBuf = Buffer.alloc(16);
      const fd = fs.openSync(uploadedFilePath, 'r');
      fs.readSync(fd, headerBuf, 0, 16, 0);
      fs.closeSync(fd);
      const sqliteHeader = headerBuf.toString('ascii', 0, 6);
      if (sqliteHeader !== 'SQLite') {
        fs.unlinkSync(uploadedFilePath);
        return res.status(400).json({ success: false, error: 'Uploaded file is not a valid SQLite database' });
      }
    } catch (err) {
      if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath);
      return res.status(400).json({ success: false, error: 'Failed to read and validate SQLite database header: ' + err.message });
    }

    // 2. Automatically create a backup of the current database before replacing
    const backupDir = path.join(path.dirname(currentDbPath), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupFilename = `coaching-backup-pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
    const backupPath = path.join(backupDir, backupFilename);
    if (fs.existsSync(currentDbPath)) {
      fs.copyFileSync(currentDbPath, backupPath);
    }

    // 3. Safely replace database file
    fs.copyFileSync(uploadedFilePath, currentDbPath);
    if (fs.existsSync(uploadedFilePath)) {
      fs.unlinkSync(uploadedFilePath);
    }

    // 4. Re-initialize database connection so the new database becomes active immediately
    await initDatabase();

    // 5. Audit Log entry (if audit_logs table exists, or console log)
    try {
      db.prepare(`
        INSERT INTO settings (key, value)
        VALUES ('last_db_restore', ? )
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(new Date().toISOString());
    } catch (e) { }

    return res.json({
      success: true,
      message: 'Database restored successfully. Active database updated and re-initialized.',
      backupCreated: backupFilename
    });
  } catch (error) {
    console.error('Database restore failed:', error);
    return res.status(500).json({ success: false, error: 'Database restore failed: ' + error.message });
  }
});

// Download database backup
apiRouter.get('/database/backup', async (req, res) => {
  try {
    const dbPath = getDbPath();
    if (fs.existsSync(dbPath)) {
      const activeYear = getActiveAcademicYear();
      res.download(dbPath, `coaching-backup-${activeYear.year}-${new Date().toISOString().split('T')[0]}.sqlite`);
    } else {
      res.status(404).json({ success: false, error: 'Database file not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
apiRouter.get('/settings/system', requireSuperAdmin, (req, res) => {
  try {
    const dbPath = getDbPath();
    const stats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
    res.json({
      success: true,
      data: {
        appName: 'Coaching Center Management System',
        edition: 'Enterprise Desktop v2.6.0',
        platform: 'Windows Desktop (Offline-First)',
        runtime: `Node.js ${process.version}`,
        database: `SQLite 3 (${path.basename(dbPath)})`,
        dbPath: dbPath,
        dbSize: stats ? `${(stats.size / 1024).toFixed(1)} KB` : 'N/A',
        lastModified: stats ? stats.mtime.toISOString().replace('T', ' ').substring(0, 19) : 'N/A',
        storageMode: 'Single Source of Truth (Zero External Cloud Dependency)'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/seed', requireSuperAdmin, (req, res) => {
  try {
    seedDefaultDataIfEmpty(true);
    res.json({ success: true, message: 'Database reset and re-seeded with realistic records successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// TEACHERS MANAGEMENT API
// ----------------------------------------------------
apiRouter.get('/teachers', (req, res) => {
  try {
    const teachers = db.prepare('SELECT * FROM teachers ORDER BY name ASC').all();

    const results = teachers.map(t => {
      const earnedRow = db.prepare(`
        SELECT COALESCE(SUM(daily_total), 0) as total_earned,
               COALESCE(SUM(classes_taken), 0) as total_classes,
               COALESCE(SUM(khatas_checked), 0) as total_khatas,
               COALESCE(SUM(guard_duties), 0) as total_guards,
               COALESCE(SUM(class_earnings), 0) as class_earnings,
               COALESCE(SUM(khata_earnings), 0) as khata_earnings,
               COALESCE(SUM(guard_earnings), 0) as guard_earnings
        FROM teacher_activities WHERE teacher_id = ?
      `).get(t.id);

      const paidRow = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total_paid
        FROM teacher_payments WHERE teacher_id = ?
      `).get(t.id);

      const totalEarned = earnedRow.total_earned || 0;
      const totalPaid = paidRow.total_paid || 0;
      const currentPayable = totalEarned - totalPaid;

      return {
        ...t,
        total_classes: earnedRow.total_classes,
        total_khatas: earnedRow.total_khatas,
        total_guards: earnedRow.total_guards,
        class_earnings: earnedRow.class_earnings,
        khata_earnings: earnedRow.khata_earnings,
        guard_earnings: earnedRow.guard_earnings,
        total_earned: totalEarned,
        total_paid: totalPaid,
        current_payable: currentPayable
      };
    });

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Teachers Dashboard Summary (Placed before /teachers/:id to prevent route shadowing)
apiRouter.get('/teachers/dashboard-summary', (req, res) => {
  try {
    const teachersCount = db.prepare('SELECT COUNT(*) as count FROM teachers').get().count;

    const allTeachers = db.prepare('SELECT id FROM teachers').all();
    let totalPayable = 0;
    for (const t of allTeachers) {
      const e = db.prepare('SELECT COALESCE(SUM(daily_total), 0) as total FROM teacher_activities WHERE teacher_id = ?').get(t.id).total;
      const p = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_payments WHERE teacher_id = ?').get(t.id).total;
      totalPayable += Math.max(0, e - p);
    }

    res.json({
      success: true,
      data: {
        totalTeachers: teachersCount,
        totalPayable
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Teacher Payment Summary (Today, Monthly, Monthly Table & Filter)
apiRouter.get('/teachers/payment-summary', (req, res) => {
  try {
    const today = getDhakaDate(); // e.g. '2026-09-28'
    const todayMonth = today.substring(0, 7); // '2026-09'

    // Selected month: query param or current month
    const selectedMonth = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
      ? req.query.month
      : todayMonth;

    // 1. Today's Total Teacher Payment
    const todayPaidRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM teacher_payments
      WHERE payment_date = ?
    `).get(today);
    const todayPaid = todayPaidRow ? todayPaidRow.total : 0;

    // 2. Selected Month Total Teacher Payment
    const monthPaidRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM teacher_payments
      WHERE payment_date LIKE ?
    `).get(`${selectedMonth}%`);
    const monthPaid = monthPaidRow ? monthPaidRow.total : 0;

    // 3. Overall All-Time Teacher Payment
    const overallPaidRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM teacher_payments
    `).get();
    const overallPaid = overallPaidRow ? overallPaidRow.total : 0;

    // 4. Monthly Teacher-wise Payment Breakdown Table
    const teacherRows = db.prepare(`
      SELECT tp.teacher_id, t.name as teacher_name, t.phone as teacher_phone,
             COALESCE(SUM(tp.amount), 0) as total_paid,
             COUNT(tp.id) as payment_count
      FROM teacher_payments tp
      JOIN teachers t ON tp.teacher_id = t.id
      WHERE tp.payment_date LIKE ?
      GROUP BY tp.teacher_id, t.name, t.phone
      ORDER BY total_paid DESC, t.name ASC
    `).all(`${selectedMonth}%`);

    // Format month name (e.g. '2026-09' -> 'September 2026')
    const [yearStr, monthStr] = selectedMonth.split('-');
    const dateObj = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, 1);
    const selectedMonthName = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // 5. Available months for the filter (from DB, plus current and recent 12 months)
    const dbMonths = db.prepare(`
      SELECT DISTINCT substr(payment_date, 1, 7) as month_val
      FROM teacher_payments
      WHERE payment_date IS NOT NULL AND payment_date != ''
      ORDER BY month_val DESC
    `).all().map(r => r.month_val);

    const monthSet = new Set(dbMonths);
    monthSet.add(todayMonth);

    const currentYear = parseInt(today.split('-')[0], 10);
    const currentMonthNum = parseInt(today.split('-')[1], 10);
    for (let i = 0; i < 12; i++) {
      const d = new Date(currentYear, currentMonthNum - 1 - i, 1);
      const mVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthSet.add(mVal);
    }

    const availableMonths = Array.from(monthSet)
      .sort((a, b) => b.localeCompare(a))
      .map(m => {
        const [y, mNum] = m.split('-');
        const dt = new Date(parseInt(y, 10), parseInt(mNum, 10) - 1, 1);
        return {
          value: m,
          label: dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        };
      });

    res.json({
      success: true,
      data: {
        todayDate: today,
        todayPaid,
        selectedMonth,
        selectedMonthName,
        monthPaid,
        overallPaid,
        teachers: teacherRows,
        availableMonths
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/teachers/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const earnedRow = db.prepare(`
      SELECT COALESCE(SUM(daily_total), 0) as total_earned,
             COALESCE(SUM(classes_taken), 0) as total_classes,
             COALESCE(SUM(khatas_checked), 0) as total_khatas,
             COALESCE(SUM(guard_duties), 0) as total_guards,
             COALESCE(SUM(class_earnings), 0) as class_earnings,
             COALESCE(SUM(khata_earnings), 0) as khata_earnings,
             COALESCE(SUM(guard_earnings), 0) as guard_earnings
      FROM teacher_activities WHERE teacher_id = ?
    `).get(id);

    const paidRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total_paid
      FROM teacher_payments WHERE teacher_id = ?
    `).get(id);

    const totalEarned = earnedRow.total_earned || 0;
    const totalPaid = paidRow.total_paid || 0;
    const currentPayable = totalEarned - totalPaid;

    const activities = db.prepare('SELECT * FROM teacher_activities WHERE teacher_id = ? ORDER BY activity_date DESC, id DESC').all(id);
    const payments = db.prepare('SELECT * FROM teacher_payments WHERE teacher_id = ? ORDER BY payment_date DESC, id DESC').all(id);

    res.json({
      success: true,
      data: {
        ...teacher,
        total_classes: earnedRow.total_classes,
        total_khatas: earnedRow.total_khatas,
        total_guards: earnedRow.total_guards,
        class_earnings: earnedRow.class_earnings,
        khata_earnings: earnedRow.khata_earnings,
        guard_earnings: earnedRow.guard_earnings,
        total_earned: totalEarned,
        total_paid: totalPaid,
        current_payable: currentPayable,
        activities,
        payments
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/teachers', (req, res) => {
  try {
    const { name, phone, per_class_rate, per_khata_rate, per_guard_rate } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Teacher name is required' });
    }

    const pClass = parseFloat(per_class_rate) || 0;
    const pKhata = parseFloat(per_khata_rate) || 0;
    const pGuard = parseFloat(per_guard_rate) || 0;

    const stmt = db.prepare(`
      INSERT INTO teachers (name, phone, per_class_rate, per_khata_rate, per_guard_rate)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(name.trim(), phone ? phone.trim() : '', pClass, pKhata, pGuard);
    const newTeacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(result.lastInsertRowid);

    res.json({
      success: true,
      message: `Teacher "${newTeacher.name}" added successfully`,
      data: newTeacher
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.put('/teachers/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, phone, per_class_rate, per_khata_rate, per_guard_rate } = req.body;

    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const tName = (name && name.trim()) ? name.trim() : teacher.name;
    const tPhone = phone !== undefined ? phone.trim() : teacher.phone;
    const pClass = per_class_rate !== undefined ? parseFloat(per_class_rate) || 0 : teacher.per_class_rate;
    const pKhata = per_khata_rate !== undefined ? parseFloat(per_khata_rate) || 0 : teacher.per_khata_rate;
    const pGuard = per_guard_rate !== undefined ? parseFloat(per_guard_rate) || 0 : teacher.per_guard_rate;

    db.prepare(`
      UPDATE teachers 
      SET name = ?, phone = ?, per_class_rate = ?, per_khata_rate = ?, per_guard_rate = ?
      WHERE id = ?
    `).run(tName, tPhone, pClass, pKhata, pGuard, id);

    const updated = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    res.json({ success: true, message: `Teacher "${updated.name}" updated successfully`, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/teachers/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    db.prepare('DELETE FROM teacher_activities WHERE teacher_id = ?').run(id);
    db.prepare('DELETE FROM teacher_payments WHERE teacher_id = ?').run(id);
    db.prepare('DELETE FROM teachers WHERE id = ?').run(id);

    res.json({ success: true, message: `Teacher "${teacher.name}" deleted successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Daily Activities
apiRouter.get('/teacher-activities', (req, res) => {
  try {
    const teacherId = req.query.teacher_id ? parseInt(req.query.teacher_id, 10) : null;
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;

    let query = `
      SELECT ta.*, t.name as teacher_name, t.phone as teacher_phone
      FROM teacher_activities ta
      JOIN teachers t ON ta.teacher_id = t.id
      WHERE 1=1
    `;
    const params = [];

    if (teacherId) {
      query += ' AND ta.teacher_id = ?';
      params.push(teacherId);
    }
    if (startDate) {
      query += ' AND ta.activity_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND ta.activity_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY ta.activity_date DESC, ta.id DESC';

    const rows = db.prepare(query).all(...params);

    let totalClasses = 0;
    let totalKhatas = 0;
    let totalGuards = 0;
    let totalEarnings = 0;

    rows.forEach(r => {
      totalClasses += r.classes_taken || 0;
      totalKhatas += r.khatas_checked || 0;
      totalGuards += r.guard_duties || 0;
      totalEarnings += r.daily_total || 0;
    });

    res.json({
      success: true,
      data: rows,
      summary: {
        totalClasses,
        totalKhatas,
        totalGuards,
        totalEarnings
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/teacher-activities', (req, res) => {
  try {
    const { teacher_id, activity_date, classes_taken, khatas_checked, guard_duties } = req.body;
    const tId = parseInt(teacher_id, 10);
    if (isNaN(tId)) {
      return res.status(400).json({ success: false, error: 'Teacher ID is required' });
    }

    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tId);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const dateStr = (activity_date && /^\d{4}-\d{2}-\d{2}$/.test(activity_date)) ? activity_date : getDhakaDate();
    const cTaken = parseInt(classes_taken, 10) || 0;
    const kChecked = parseInt(khatas_checked, 10) || 0;
    const gDuties = parseInt(guard_duties, 10) || 0;

    const pClass = teacher.per_class_rate;
    const pKhata = teacher.per_khata_rate;
    const pGuard = teacher.per_guard_rate;

    const classEarnings = cTaken * pClass;
    const khataEarnings = kChecked * pKhata;
    const guardEarnings = gDuties * pGuard;
    const dailyTotal = classEarnings + khataEarnings + guardEarnings;

    const stmt = db.prepare(`
      INSERT INTO teacher_activities (
        teacher_id, activity_date, classes_taken, khatas_checked, guard_duties,
        per_class_rate, per_khata_rate, per_guard_rate,
        class_earnings, khata_earnings, guard_earnings, daily_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      tId, dateStr, cTaken, kChecked, gDuties,
      pClass, pKhata, pGuard,
      classEarnings, khataEarnings, guardEarnings, dailyTotal
    );

    res.json({
      success: true,
      message: 'Daily activity recorded successfully',
      data: { id: Number(result.lastInsertRowid), daily_total: dailyTotal }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.put('/teacher-activities/:id', (req, res) => {
  return res.status(403).json({
    success: false,
    error: 'Work records cannot be edited once saved. To add more work, please record a new daily activity.'
  });
});

apiRouter.delete('/teacher-activities/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const activity = db.prepare('SELECT * FROM teacher_activities WHERE id = ?').get(id);
    if (!activity) {
      return res.status(404).json({ success: false, error: 'Activity record not found' });
    }

    db.prepare('DELETE FROM teacher_activities WHERE id = ?').run(id);
    res.json({ success: true, message: 'Activity record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Teacher Payments
apiRouter.get('/teacher-payments', (req, res) => {
  try {
    const teacherId = req.query.teacher_id ? parseInt(req.query.teacher_id, 10) : null;
    let query = `
      SELECT tp.*, t.name as teacher_name, t.phone as teacher_phone
      FROM teacher_payments tp
      JOIN teachers t ON tp.teacher_id = t.id
      WHERE 1=1
    `;
    const params = [];
    if (teacherId) {
      query += ' AND tp.teacher_id = ?';
      params.push(teacherId);
    }
    query += ' ORDER BY tp.payment_date DESC, tp.id DESC';

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/teachers/:id/pay', (req, res) => {
  try {
    const teacherId = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const earnedRow = db.prepare('SELECT COALESCE(SUM(daily_total), 0) as total FROM teacher_activities WHERE teacher_id = ?').get(teacherId);
    const paidRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_payments WHERE teacher_id = ?').get(teacherId);

    const currentEarned = earnedRow.total || 0;
    const currentPaid = paidRow.total || 0;
    const currentPayable = currentEarned - currentPaid;

    const reqAmount = req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== ''
      ? parseFloat(req.body.amount)
      : Math.max(0, currentPayable);

    if (isNaN(reqAmount) || reqAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid payment amount' });
    }

    const payAmount = reqAmount;

    const paymentDate = (req.body.payment_date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.payment_date))
      ? req.body.payment_date
      : getDhakaDate();

    const isAdvance = payAmount > currentPayable;
    const defaultNote = isAdvance ? `Advance payment to ${teacher.name}` : `Salary paid to ${teacher.name}`;
    const note = req.body.note && req.body.note.trim()
      ? req.body.note.trim()
      : defaultNote;

    // 1. Insert into teacher_payments
    const payResult = db.prepare(`
      INSERT INTO teacher_payments (teacher_id, payment_date, amount, note)
      VALUES (?, ?, ?, ?)
    `).run(teacherId, paymentDate, payAmount, note);

    // 2. Ensure "Teacher Salary" expense category exists in expense_categories
    let teacherCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Teacher Salary'").get();
    if (!teacherCat) {
      const catRes = db.prepare("INSERT INTO expense_categories (name, is_default) VALUES ('Teacher Salary', 1)").run();
      teacherCat = { id: Number(catRes.lastInsertRowid) };
    }

    // 3. Generate sequential voucher number matching institutional expenses
    const maxVoucher = db.prepare('SELECT COUNT(*) as count FROM expenses').get();
    const voucherNo = `V-${String(100 + (maxVoucher ? maxVoucher.count : 0) + 1)}`;

    // 4. Create matching expense entry linked directly to the Expense section
    db.prepare(`
      INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      teacherCat.id,
      payAmount,
      note,
      paymentDate,
      getDhakaTime(),
      voucherNo
    );

    const newPayable = currentPayable - payAmount;

    res.json({
      success: true,
      message: `Successfully paid ৳${payAmount.toLocaleString()} to ${teacher.name}. Balance is now ৳${newPayable.toLocaleString()}.`,
      data: {
        paymentId: Number(payResult.lastInsertRowid),
        paidAmount: payAmount,
        paymentDate,
        voucherNo,
        currentPayable: newPayable
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/teachers/advance-statement', (req, res) => {
  try {
    const date = req.query.date || getDhakaDate();
    const payments = db.prepare(`
      SELECT tp.*, t.name as teacher_name, t.phone as teacher_phone
      FROM teacher_payments tp
      JOIN teachers t ON tp.teacher_id = t.id
      WHERE tp.payment_date = ?
      ORDER BY tp.id DESC
    `).all(date);

    let totalAmount = 0;
    const items = payments.map(p => {
      totalAmount += p.amount || 0;
      const isAdvance = p.note && /advance/i.test(p.note);
      return {
        id: p.id,
        date: p.payment_date,
        payment_date: p.payment_date,
        teacher_name: p.teacher_name,
        teacher_phone: p.teacher_phone,
        amount: p.amount,
        payment_type: isAdvance ? 'Advance' : 'Payment / Advance',
        description: p.note || 'Teacher Payment/Advance',
        note: p.note || 'Teacher Payment/Advance'
      };
    });

    res.json({
      success: true,
      date,
      totalAmount,
      count: items.length,
      payments: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// STAFF MANAGEMENT & ADVANCE ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/staff', (req, res) => {
  try {
    const staffList = db.prepare('SELECT * FROM staff ORDER BY name ASC').all();
    const results = staffList.map(st => {
      const paidRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM staff_payments WHERE staff_id = ?').get(st.id);
      return {
        ...st,
        total_paid: paidRow.total || 0
      };
    });
    res.json({ success: true, staff: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/staff/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff member not found' });
    }
    const paidRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM staff_payments WHERE staff_id = ?').get(id);
    const payments = db.prepare('SELECT * FROM staff_payments WHERE staff_id = ? ORDER BY payment_date DESC, id DESC').all(id);

    res.json({
      success: true,
      data: {
        ...staff,
        total_paid: paidRow ? (paidRow.total || 0) : 0,
        payments
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/staff', (req, res) => {
  try {
    const { name, phone, address, work_post, fixed_salary } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Staff name is required' });
    }
    const salary = parseFloat(fixed_salary) || 0;
    const stmt = db.prepare(`
      INSERT INTO staff (name, phone, address, work_post, fixed_salary)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      name.trim(),
      phone ? phone.trim() : '',
      address ? address.trim() : '',
      work_post ? work_post.trim() : '',
      salary
    );
    const newStaff = db.prepare('SELECT * FROM staff WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, message: `Staff "${newStaff.name}" added successfully`, data: newStaff });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.put('/staff/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff not found' });
    }
    const name = req.body.name !== undefined ? req.body.name.trim() : staff.name;
    const phone = req.body.phone !== undefined ? req.body.phone.trim() : staff.phone;
    const address = req.body.address !== undefined ? req.body.address.trim() : (staff.address || '');
    const work_post = req.body.work_post !== undefined ? req.body.work_post.trim() : (staff.work_post || '');
    const fixed_salary = req.body.fixed_salary !== undefined ? (parseFloat(req.body.fixed_salary) || 0) : staff.fixed_salary;

    db.prepare(`
      UPDATE staff
      SET name = ?, phone = ?, address = ?, work_post = ?, fixed_salary = ?
      WHERE id = ?
    `).run(name, phone, address, work_post, fixed_salary, id);

    const updated = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    res.json({ success: true, message: `Staff "${updated.name}" updated successfully`, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/staff/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff not found' });
    }
    db.prepare('DELETE FROM staff_payments WHERE staff_id = ?').run(id);
    db.prepare('DELETE FROM staff WHERE id = ?').run(id);
    res.json({ success: true, message: `Staff "${staff.name}" deleted successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/staff/:id/pay', (req, res) => {
  try {
    const staffId = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff not found' });
    }

    const { amount, payment_date, note } = req.body;
    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid payment amount is required' });
    }

    const paymentDate = (payment_date && /^\d{4}-\d{2}-\d{2}$/.test(payment_date)) ? payment_date : getDhakaDate();
    const isAdvance = payAmount > (staff.fixed_salary || 0);
    const defaultNote = isAdvance ? `Advance payment to staff ${staff.name}` : `Salary / Advance paid to staff ${staff.name}`;
    const payNote = note && note.trim() ? note.trim() : defaultNote;

    // 1. Insert into staff_payments (Stores dedicated staff payment/advance history)
    const payResult = db.prepare(`
      INSERT INTO staff_payments (staff_id, payment_date, amount, note)
      VALUES (?, ?, ?, ?)
    `).run(staffId, paymentDate, payAmount, payNote);

    // 2. Ensure "Staff Salary" expense category exists in expense_categories
    let staffCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Staff Salary'").get();
    if (!staffCat) {
      const catRes = db.prepare("INSERT INTO expense_categories (name, is_default) VALUES ('Staff Salary', 1)").run();
      staffCat = { id: Number(catRes.lastInsertRowid) };
    }

    // 3. Generate sequential voucher number matching application expenses
    const maxVoucher = db.prepare('SELECT COUNT(*) as count FROM expenses').get();
    const voucherNo = `V-${String(100 + (maxVoucher ? maxVoucher.count : 0) + 1)}`;

    // 4. Create matching expense entry linked directly to the Expense system
    db.prepare(`
      INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      staffCat.id,
      payAmount,
      payNote,
      paymentDate,
      getDhakaTime(),
      voucherNo
    );

    res.json({
      success: true,
      message: `Successfully recorded ৳${payAmount.toLocaleString()} payment/advance for staff ${staff.name}. Added to Expense system.`,
      data: {
        paymentId: Number(payResult.lastInsertRowid),
        paidAmount: payAmount,
        paymentDate,
        voucherNo
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/staff/advance-statement', (req, res) => {
  try {
    const date = req.query.date || getDhakaDate();
    const payments = db.prepare(`
      SELECT sp.*, s.name as staff_name, s.phone as staff_phone, s.address, s.work_post, s.fixed_salary
      FROM staff_payments sp
      JOIN staff s ON sp.staff_id = s.id
      WHERE sp.payment_date = ?
      ORDER BY sp.id DESC
    `).all(date);

    let totalAmount = 0;
    const items = payments.map(p => {
      totalAmount += p.amount || 0;
      const isAdvance = p.amount > (p.fixed_salary || 0) || (p.note && /advance/i.test(p.note));
      return {
        id: p.id,
        date: p.payment_date,
        payment_date: p.payment_date,
        staff_name: p.staff_name,
        staff_phone: p.staff_phone,
        work_post: p.work_post || 'Office Staff',
        address: p.address || '',
        fixed_salary: p.fixed_salary || 0,
        amount: p.amount,
        payment_type: isAdvance ? 'Advance' : 'Salary Payment',
        description: p.note || 'Staff Salary / Advance',
        note: p.note || 'Staff Salary / Advance'
      };
    });

    res.json({
      success: true,
      date,
      totalAmount,
      count: items.length,
      payments: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// OTHERS INCOME ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/others-income', (req, res) => {
  try {
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    let query = 'SELECT * FROM other_collections WHERE 1=1';
    const params = [];

    if (startDate) {
      query += ' AND collection_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND collection_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY collection_date DESC, id DESC';
    const items = db.prepare(query).all(...params);

    let totalAmount = 0;
    items.forEach(i => totalAmount += (i.amount || 0));

    res.json({
      success: true,
      totalAmount,
      count: items.length,
      collections: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/others-income', (req, res) => {
  try {
    const { description, amount, collection_date, note } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, error: 'Description is required for Others income' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid positive amount is required' });
    }

    const collectionDate = (collection_date && /^\d{4}-\d{2}-\d{2}$/.test(collection_date)) ? collection_date : getDhakaDate();
    const collectionTime = getDhakaTime();

    const maxCol = db.prepare('SELECT COUNT(*) as count FROM other_collections').get();
    const receiptNo = `OTH-${String(1000 + (maxCol ? maxCol.count : 0) + 1)}`;

    const stmt = db.prepare(`
      INSERT INTO other_collections (description, amount, collection_date, collection_time, receipt_no, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(description.trim(), amt, collectionDate, collectionTime, receiptNo, note ? note.trim() : description.trim());

    res.json({
      success: true,
      message: `Successfully recorded Others income: ${description.trim()} (৳${amt.toLocaleString()})`,
      data: {
        id: Number(result.lastInsertRowid),
        receipt_no: receiptNo,
        description: description.trim(),
        amount: amt,
        collection_date: collectionDate,
        collection_time: collectionTime
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/others-income/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.prepare('SELECT * FROM other_collections WHERE id = ?').get(id);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }
    db.prepare('DELETE FROM other_collections WHERE id = ?').run(id);
    res.json({ success: true, message: 'Others income record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/seed', requireSuperAdmin, (req, res) => {
  try {
    seedDefaultDataIfEmpty(true);
    res.json({ success: true, message: 'Database reset and re-seeded with realistic records successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/reset-operational', requireSuperAdmin, (req, res) => {
  try {
    db.exec(`
      DELETE FROM payments;
      DELETE FROM expenses;
      DELETE FROM students;
    `);
    res.json({
      success: true,
      message: 'All students, payments, and expenses were cleared. Classes and academic year settings were kept.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});